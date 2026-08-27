import type {
  HermesCardOperation,
  HermesCardActivity,
  HermesCardWatch,
  HermesWatchKind,
  KanbanCard,
  KanbanCiChecks,
  ComponentId,
  KanbanPrepStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Pure client Hermes / Prompt prep decisions.
 *
 * Skill runs live in the browser tab. Refresh drops in-memory jobs but can leave
 * `prepStatus: "processing"` in SQLite — that must not look like live work, and
 * auto-skills must not re-fire on every Prompt after reload.
 */

export type BoardHermesCardSlice = {
  readonly id: string;
  readonly at: ComponentId;
  readonly prepStatus?: KanbanPrepStatus | null;
  readonly hermesOperation?: HermesCardOperation | null;
};

export type BoardHermesClientAction =
  | { readonly kind: "clear_orphaned_processing"; readonly cardIds: ReadonlyArray<string> }
  | { readonly kind: "promote_untouched_without_skills"; readonly cardIds: ReadonlyArray<string> }
  | { readonly kind: "start_auto_skills"; readonly cardIds: ReadonlyArray<string> }
  /** Client auto-skills would run but the skill instance is unusable. */
  | { readonly kind: "usage_blocked"; readonly cardIds: ReadonlyArray<string> }
  | { readonly kind: "noop" };

/**
 * Model the client skill pipeline calls.
 * Prefer the board skills model; else the Hermes brain selection (same Hermes the
 * owner configured); never invent a third provider from nowhere.
 */
export function resolveBoardSkillModelSelection(input: {
  readonly hermesInstanceId?: string | null;
  readonly hermesModel?: string | null;
  readonly hermesBrainInstanceId?: string | null;
  readonly hermesBrainModel?: string | null;
  readonly textGeneration?: { readonly instanceId: string; readonly model: string } | null;
}): { readonly instanceId: string; readonly model: string } | null {
  const skillsInstance = input.hermesInstanceId?.trim();
  const skillsModel = input.hermesModel?.trim();
  if (skillsInstance && skillsModel) {
    return { instanceId: skillsInstance, model: skillsModel };
  }
  const brainInstance = input.hermesBrainInstanceId?.trim();
  const brainModel = input.hermesBrainModel?.trim();
  if (brainInstance && brainModel) {
    return { instanceId: brainInstance, model: brainModel };
  }
  const textGen = input.textGeneration;
  if (textGen?.instanceId && textGen.model) {
    return { instanceId: String(textGen.instanceId), model: textGen.model };
  }
  return null;
}

/** Instance id used for skill usage checks (skills → brain → text-gen → codex). */
export function resolveBoardSkillInstanceId(input: {
  readonly hermesInstanceId?: string | null;
  readonly hermesModel?: string | null;
  readonly hermesBrainInstanceId?: string | null;
  readonly hermesBrainModel?: string | null;
  readonly textGenerationInstanceId?: string | null;
}): string {
  const skillsInstance = input.hermesInstanceId?.trim();
  const skillsModel = input.hermesModel?.trim();
  if (skillsInstance && skillsModel) return skillsInstance;

  const brainInstance = input.hermesBrainInstanceId?.trim();
  const brainModel = input.hermesBrainModel?.trim();
  if (brainInstance && brainModel) return brainInstance;

  const textGen = input.textGenerationInstanceId?.trim();
  if (textGen) return textGen;

  return "codex";
}

/**
 * Client auto-skills only while the brain is off. Hermes owns structuring when
 * enabled. Pass live status with settings fallback so load races do not open
 * the client path under an on-by-default brain.
 */
export function clientAutoSkillsEnabled(input: {
  readonly brainEnabled: boolean;
  readonly structureDrafts: boolean;
}): boolean {
  if (input.brainEnabled) return false;
  return input.structureDrafts;
}

export function prepStatusOf(card: {
  readonly prepStatus?: KanbanPrepStatus | null;
}): KanbanPrepStatus {
  return card.prepStatus ?? "untouched";
}

/** Badge / dialog spinner: only real in-tab skill jobs, never stale prepStatus. */
export function isLiveHermesWorking(hasLiveSkillJob: boolean): boolean {
  return hasLiveSkillJob;
}

/**
 * Prompts stuck at processing with no live browser job (typical after refresh).
 */
export function listOrphanedProcessingDraftIds(
  cards: ReadonlyArray<BoardHermesCardSlice>,
  liveSkillJobIds: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const card of cards) {
    if (card.at !== "prompts") continue;
    if (prepStatusOf(card) !== "processing") continue;
    if (liveSkillJobIds.has(card.id)) continue;
    out.push(card.id);
  }
  return out;
}

/**
 * Prompts eligible for auto skill-run: untouched only.
 * `ready` = already processed; `processing` = live or orphan (handled first).
 */
export function listUntouchedDraftIds(
  cards: ReadonlyArray<BoardHermesCardSlice>,
  options: {
    readonly liveSkillJobIds: ReadonlySet<string>;
    readonly sessionStartedIds: ReadonlySet<string>;
  },
): string[] {
  const out: string[] = [];
  for (const card of cards) {
    if (card.at !== "prompts") continue;
    if (prepStatusOf(card) !== "untouched") continue;
    if (options.liveSkillJobIds.has(card.id)) continue;
    if (options.sessionStartedIds.has(card.id)) continue;
    out.push(card.id);
  }
  return out;
}

/**
 * After a successful skill pipeline, mark ready so refresh does not treat the
 * card as brand-new capture fodder.
 */
export function prepStatusAfterSkillsStayInDraft(): KanbanPrepStatus {
  return "ready";
}

export function prepStatusAfterSkillsPromote(): KanbanPrepStatus {
  return "ready";
}

export function prepStatusAfterSkillsFailure(): KanbanPrepStatus {
  return "untouched";
}

/**
 * One board-pass decision for the client Hermes effect.
 * Orphans always win: clear them and stop so the next pass can auto-skill cleanly.
 */
export function planBoardHermesClientPass(input: {
  readonly cards: ReadonlyArray<BoardHermesCardSlice>;
  readonly liveSkillJobIds: ReadonlySet<string>;
  readonly sessionStartedIds: ReadonlySet<string>;
  readonly autoApplySkills: boolean;
  readonly usageBlocked: boolean;
  readonly hasSkillPipeline: boolean;
}): BoardHermesClientAction {
  const orphans = listOrphanedProcessingDraftIds(input.cards, input.liveSkillJobIds);
  if (orphans.length > 0) {
    return { kind: "clear_orphaned_processing", cardIds: orphans };
  }

  if (!input.autoApplySkills) {
    return { kind: "noop" };
  }

  const untouched = listUntouchedDraftIds(input.cards, {
    liveSkillJobIds: input.liveSkillJobIds,
    sessionStartedIds: input.sessionStartedIds,
  });
  if (untouched.length === 0) {
    return { kind: "noop" };
  }

  if (!input.hasSkillPipeline) {
    return { kind: "promote_untouched_without_skills", cardIds: untouched };
  }

  // Only report usage_blocked when there is real work the skill instance would run.
  if (input.usageBlocked) {
    return { kind: "usage_blocked", cardIds: untouched };
  }

  return { kind: "start_auto_skills", cardIds: untouched };
}

export type BoardQueueTone = "running" | "queued" | "idle" | "blocked" | "applied";

/**
 * The card's one status line. A card never carries two of these: whatever is
 * truest right now wins, in the order running → failed → queued → receipt.
 */
export type CardQueueState = {
  readonly label: string;
  readonly tone: BoardQueueTone;
  readonly title: string;
  readonly pulse?: boolean;
};

/**
 * `BoardApi` method → the step it is, in both tenses. The server writes the
 * present-tense one into `operation.detail`; the method is what survives a
 * label change, so the card reads from it and falls back to the detail.
 */
const OPERATION_STEPS: Record<string, { readonly running: string; readonly past: string }> = {
  updateCard: { running: "Structuring", past: "Structured" },
  createCard: { running: "Adding card", past: "Added card" },
  launchActive: { running: "Launching agent", past: "Launched" },
  openPr: { running: "Opening PR", past: "Opened PR" },
  mergePr: { running: "Merging PR", past: "Merged PR" },
  syncPrBranch: { running: "Syncing PR branch", past: "Synced PR branch" },
  restorePrWorktree: { running: "Restoring worktree", past: "Restored worktree" },
  nudgeThread: { running: "Nudging agent", past: "Nudged agent" },
  launchHelper: { running: "Asking helper", past: "Asked helper" },
  archiveThread: { running: "Archiving thread", past: "Archived thread" },
  archiveCard: { running: "Archiving", past: "Archived" },
  answerPermission: { running: "Answering permission", past: "Answered permission" },
};

/** What Hermes is carrying this card for, named as the step it is. */
const WATCH_KIND_STEPS: Record<HermesWatchKind, string> = {
  structure: "Structuring",
  route: "Routing project",
  review: "Judging transcript",
  blocked: "Unblocking",
  answer: "Answering permission",
  helper: "Asking helper",
  message: "Answering you",
};

function operationStep(method: string, detail: string): { running: string; past: string } {
  return OPERATION_STEPS[method] ?? { running: detail, past: detail };
}

export type BoardQueueContext = {
  /** Hermes brain switch (Settings → Hermes → Enable Hermes). */
  readonly brainEnabled: boolean;
  /** Brain policy: structure Prompts / apply skills. */
  readonly autoStructureDrafts: boolean;
  /** Legacy Draft → Prompts hop (no-op; kept for settings shape). */
  readonly autoMoveDraftsToPrompts: boolean;
  /** Brain policy: Prompts → Active. */
  readonly autoLaunchPrompts: boolean;
  /** Usage caps that stop the in-tab skill pipeline. */
  readonly usageBlocked: boolean;
  /**
   * Why the loop cannot reach a model at all — a failing box check, or a board
   * brain with no transport. A card that says "Queued · 27s" while this is set
   * is counting down to a tick that will not do anything.
   */
  readonly loopBlocked?: string | null;
  /** A tick is running right now. */
  readonly busy?: boolean;
  /** Epoch ms of the next scheduled tick, for the countdown. */
  readonly nextTickAtMs?: number | null;
  readonly nowMs?: number;
  /** What Hermes last did to each card, from the last tick. */
  readonly activityByCardId?: ReadonlyMap<string, HermesCardActivity>;
  /** Cards Hermes is still undecided about, with their fruitless-look count. */
  readonly watchByCardId?: ReadonlyMap<string, HermesCardWatch>;
  /** Epoch ms of the deadline at which a parked card is judged again. */
  readonly nextModelCheckAtMs?: number | null;
};

/** How long a card keeps showing what Hermes did to it. */
const APPLIED_WINDOW_MS = 10 * 60_000;

function relativeAge(ms: number): string {
  if (ms < 10_000) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  return `${Math.round(ms / 60_000)}m ago`;
}

/**
 * The queue line, unless the loop cannot run — then the reason, in its place.
 *
 * Every "Queued · …" on the board is a promise that the next tick picks this
 * card up. While a box check fails or the brain has no transport, no tick does,
 * and the countdown resets forever on a card nothing is coming for.
 */
function queued(input: {
  readonly step: string;
  readonly title: string;
  readonly ctx: BoardQueueContext;
}): CardQueueState {
  const blocked = input.ctx.loopBlocked;
  if (blocked) {
    return {
      label: `Hermes blocked · ${input.step}`,
      tone: "blocked",
      title: `${blocked} Until that is fixed, no tick will ${input.step.toLowerCase()} this card.`,
    };
  }
  return {
    label: `Queued · ${input.step}${queuedSuffix(input.ctx)}`,
    tone: "queued",
    title: input.title,
  };
}

/** "Queued · Hermes" alone never answers "when". The countdown does. */
function queuedSuffix(ctx: BoardQueueContext): string {
  if (ctx.busy === true) return " · now";
  const now = ctx.nowMs;
  const next = ctx.nextTickAtMs;
  if (now === undefined || next === null || next === undefined) return "";
  const seconds = Math.round((next - now) / 1000);
  if (seconds <= 0) return " · now";
  return seconds < 60 ? ` · ${seconds}s` : ` · ${Math.round(seconds / 60)}m`;
}

/**
 * What Hermes actually did to this card, once. This is the receipt: a card that
 * was picked up says so on its face instead of silently changing column.
 */
function describeApplied(input: {
  readonly cardId: string;
  readonly ctx: BoardQueueContext;
}): CardQueueState | null {
  const entry = input.ctx.activityByCardId?.get(input.cardId);
  const now = input.ctx.nowMs;
  if (!entry || now === undefined) return null;
  const age = now - Date.parse(entry.at);
  if (!Number.isFinite(age) || age < 0 || age > APPLIED_WINDOW_MS) return null;
  const action = entry.action.charAt(0).toUpperCase() + entry.action.slice(1);
  return entry.ok
    ? {
        label: `${action} · ${relativeAge(age)}`,
        tone: "applied",
        title: `Hermes ${entry.action} on its last tick.`,
      }
    : {
        label: `Failed · ${entry.action}`,
        tone: "blocked",
        title: `Hermes tried to ${entry.action} and the call failed. Settings → Hermes → Tick log has the transcript.`,
      };
}

function untilSuffix(atMs: number | null | undefined, nowMs: number | undefined): string {
  if (atMs === null || atMs === undefined || nowMs === undefined) return "";
  const seconds = Math.round((atMs - nowMs) / 1000);
  if (seconds <= 0) return " · now";
  return seconds < 60 ? ` · ${seconds}s` : ` · ${Math.round(seconds / 60)}m`;
}

/**
 * A card Hermes keeps judging without moving. This is the state that used to be
 * invisible: the queue re-offers the card every recheck, the model declines to
 * move it, and the column shows a card that looks finished forever.
 */
function describeStalledReview(input: {
  readonly cardId: string;
  readonly ctx: BoardQueueContext;
}): CardQueueState | null {
  const watch = input.ctx.watchByCardId?.get(input.cardId);
  if (!input.ctx.brainEnabled || !watch?.stalled) return null;
  return {
    label: `Needs you · looked ${watch.reviews}×`,
    tone: "blocked",
    title: `Hermes has judged this card ${watch.reviews} times since ${watch.sinceAt} and never moved it: "${watch.why}". Open the chat and finish it, or drag it back to Prompts. Settings → Hermes → Tick log has the transcripts.`,
  };
}

function describeDurableOperation(input: {
  readonly operation: HermesCardOperation | null | undefined;
  readonly nowMs: number | undefined;
}): CardQueueState | null {
  const operation = input.operation;
  if (!operation) return null;
  const step = operationStep(operation.method, operation.detail);
  if (operation.status === "running") {
    return {
      label: step.running,
      tone: "running",
      title: `Hermes is applying this operation now. Attempt ${operation.attempt}.`,
      pulse: true,
    };
  }
  if (operation.status === "failed" || operation.status === "interrupted") {
    return {
      label: `${operation.status === "failed" ? "Failed" : "Interrupted"} · ${step.running}`,
      tone: "blocked",
      title:
        operation.error ??
        `Hermes ${operation.status} this operation on attempt ${operation.attempt}.`,
    };
  }
  const finishedAt = operation.finishedAt
    ? DateTime.toEpochMillis(operation.finishedAt)
    : Number.NaN;
  const age = input.nowMs === undefined ? Number.NaN : input.nowMs - finishedAt;
  if (!Number.isFinite(age) || age < 0 || age > APPLIED_WINDOW_MS) return null;
  return {
    label: `${step.past} · ${relativeAge(age)}`,
    tone: "applied",
    title: `Hermes applied this operation on attempt ${operation.attempt}.`,
  };
}

/**
 * The card's single status line: what is happening to it, what will, or that
 * nothing will — a Draft no loop is going to pick up must say so, not sit
 * looking busy. Everything the card used to say in two badges resolves here.
 */
export function describeCardQueue(input: {
  readonly card: BoardHermesCardSlice;
  readonly hasLiveSkillJob: boolean;
  readonly context: BoardQueueContext;
}): CardQueueState | null {
  if (input.hasLiveSkillJob) {
    return {
      label: "Applying skills",
      tone: "running",
      title: "The in-tab skill pipeline is rewriting this card.",
      pulse: true,
    };
  }
  const { context: ctx } = input;

  const durable = describeDurableOperation({
    operation: input.card.hermesOperation,
    nowMs: ctx.nowMs,
  });
  // A running or failed operation still owns the badge. An applied one does
  // not: its receipt expires, and a card that has been parked since must not
  // spend its last ten readable minutes advertising a write that changed
  // nothing.
  if (durable && durable.tone !== "applied") return durable;

  const stalled = describeStalledReview({ cardId: input.card.id, ctx });
  if (stalled) return stalled;

  if (durable) return durable;

  const applied = describeApplied({ cardId: input.card.id, ctx });
  if (applied) return applied;

  if (input.card.at === "prompts") {
    const prep = prepStatusOf(input.card);

    // Structuring only while Hermes has claimed this card (prep=processing).
    if (prep === "processing") {
      if (ctx.loopBlocked) {
        return {
          label: "Hermes blocked · Structuring",
          tone: "blocked",
          title: `${ctx.loopBlocked} Structure was claimed but the loop cannot finish it.`,
        };
      }
      return {
        label: "Structuring",
        tone: "running",
        title: "Hermes is structuring this Prompt on the current tick.",
        pulse: true,
      };
    }

    // Fail loud: last structure attempt did not land ready.
    if (prep === "failed") {
      return {
        label: "Failed · Structuring",
        tone: "blocked",
        title:
          "Hermes tried to structure this Prompt and did not land ready (timeout, empty program, or refuse). It will retry on the next tick, or fix the brain transport in Settings → Hermes.",
      };
    }

    if (prep !== "ready") {
      if (ctx.brainEnabled) {
        if (ctx.autoStructureDrafts) {
          return queued({
            step: "Waiting",
            ctx,
            title:
              ctx.busy === true
                ? "Hermes is mid-tick on other work — this Prompt is next for structure."
                : "Waiting for the next Hermes tick to pick this Prompt up for structure.",
          });
        }
        return {
          label: "Hermes idle",
          tone: "idle",
          title:
            "Hermes is on but auto-structure is off, so it will leave this card alone. Settings → Board → Hermes automation.",
        };
      }
      // Brain off: only untouched Prompts are auto-skill fodder — `ready` means the
      // pipeline already ran and the card is waiting on launch / the user.
      if (ctx.autoStructureDrafts) {
        if (ctx.usageBlocked) {
          return {
            label: "Auto-skills paused",
            tone: "blocked",
            title: "Usage caps stopped the skill pipeline. Switch provider or wait for the reset.",
          };
        }
        return {
          label: "Queued · auto-skills",
          tone: "queued",
          title: "Waiting for the in-tab auto-skill pass (Hermes brain is off).",
        };
      }
      return {
        label: "Manual",
        tone: "idle",
        title:
          "Nothing auto-processes this Prompt: Hermes is off and auto-skills are off. Apply skills yourself.",
      };
    }
    if (ctx.brainEnabled) {
      return ctx.autoLaunchPrompts
        ? queued({
            step: "Launching agent",
            ctx,
            title: "Waiting for the next Hermes tick to launch this card.",
          })
        : {
            label: "Hermes idle",
            tone: "idle",
            title:
              "Hermes is on but auto-launch is off, so it will not start this card. Settings → Board → Hermes automation.",
          };
    }
    if (prep === "ready") {
      return {
        label: "Ready",
        tone: "idle",
        title: "Skills already applied. Drag to Active when it looks right.",
      };
    }
    return null;
  }

  // Active and PR cards say nothing while their agent works — the thread chip
  // owns that. The moment the agent stops, the card is Hermes's to decide, and
  // the queue entry is the only thing that can say so.
  if (ctx.brainEnabled) {
    const watch = ctx.watchByCardId?.get(input.card.id);
    if (watch) {
      const step = WATCH_KIND_STEPS[watch.kind];
      return watch.reviews < 1
        ? queued({ step, ctx, title: `Waiting for the next Hermes tick: ${watch.why}` })
        : {
            label: `${step} · looked ${watch.reviews}×${untilSuffix(ctx.nextModelCheckAtMs, ctx.nowMs)}`,
            tone: "queued",
            title: `Hermes has judged this card ${watch.reviews} times and left it here: "${watch.why}". Nothing changed on the board, so the next look is the timed recheck.`,
          };
    }
  }

  return null;
}

/** Column header line: how many cards a loop is actually going to pick up. */
export function countQueuedCards(
  cards: ReadonlyArray<BoardHermesCardSlice>,
  input: { readonly liveSkillJobIds: ReadonlySet<string>; readonly context: BoardQueueContext },
): number {
  let queued = 0;
  for (const card of cards) {
    const state = describeCardQueue({
      card,
      hasLiveSkillJob: input.liveSkillJobIds.has(card.id),
      context: input.context,
    });
    if (state?.tone === "queued") queued += 1;
  }
  return queued;
}

/**
 * Whether queue badges need a live clock (countdown / "ago"). When false the
 * board can skip the 1 Hz `useNowMs` tick that was re-rendering every column.
 */
export function boardNeedsLiveQueueClock(
  cards: ReadonlyArray<BoardHermesCardSlice>,
  context: Omit<BoardQueueContext, "nowMs">,
): boolean {
  if (context.activityByCardId?.size || context.watchByCardId?.size) return true;
  for (const card of cards) {
    if (card.hermesOperation) return true;
  }
  if (!context.brainEnabled) return false;
  const autoOn = context.autoStructureDrafts || context.autoLaunchPrompts;
  if (!autoOn) return false;
  // Queued countdown only matters when a tick is scheduled or mid-flight.
  if (context.busy === true) return true;
  if (context.nextTickAtMs != null && Number.isFinite(context.nextTickAtMs)) return true;
  if (context.nextModelCheckAtMs != null && Number.isFinite(context.nextModelCheckAtMs)) {
    return true;
  }
  return false;
}

/**
 * How long the card has sat in this column, at the resolution a human reads:
 * a card parked for three days is the thing the board has to show, and the
 * seconds of it are noise.
 */
export function formatTimeInColumn(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 60_000) return "just now";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Tokens at board resolution: `128k`, `9.4k`, `840`. */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  if (tokens < 1000) return String(Math.round(tokens));
  const thousands = tokens / 1000;
  if (thousands < 10) return `${thousands.toFixed(1)}k`;
  if (thousands < 1000) return `${Math.round(thousands)}k`;
  return `${(thousands / 1000).toFixed(1)}M`;
}

/**
 * The card's own clock: creation → the last stage it reached. Still running
 * while the card is short of Done, so a card in Active reads the same age it
 * will read once it ships.
 */
export function cardElapsedMs(card: KanbanCard, nowMs: number): number {
  const start = DateTime.toEpochMillis(card.createdAt);
  const shipped = card.timeline.shippedAt;
  const end = shipped ? DateTime.toEpochMillis(shipped) : nowMs;
  return Math.max(0, end - start);
}

/** Narrow KanbanCard → slice for planning (keeps tests free of DateTime fixtures). */
export function toBoardHermesCardSlice(card: KanbanCard): BoardHermesCardSlice {
  return {
    id: card.id,
    at: card.at,
    prepStatus: card.prepStatus,
    hermesOperation: card.hermesOperation,
  };
}

export type PrCheckBadge = {
  readonly label: string;
  readonly tone: "running" | "failed" | "passed";
  readonly title: string;
  readonly pulse: boolean;
};

/**
 * CI badge for a card's PR. An unread or check-less PR is explicit unknown —
 * it must not read as green or as a silent blank.
 */
export function describePrChecks(
  checks: KanbanCiChecks | null | undefined,
  hasPr = true,
): PrCheckBadge | null {
  if (!hasPr) return null;
  if (!checks) {
    return {
      label: "CI unknown",
      tone: "running",
      title: "CI status has not been fetched yet.",
      pulse: true,
    };
  }
  if (checks.state === "unknown") {
    return {
      label:
        checks.unknownReason === "no_checks"
          ? "CI unknown · no checks"
          : "CI unknown · unavailable",
      tone: "running",
      title: checks.unknownDetail ?? "The forge did not return a CI verdict.",
      pulse: true,
    };
  }
  if (checks.state === "failing") {
    const names = checks.failingNames.join(", ");
    return {
      label: `CI failed · ${checks.failing}`,
      tone: "failed",
      title: names.length > 0 ? `Failing: ${names}` : "A required check is red.",
      pulse: false,
    };
  }
  if (checks.state === "pending") {
    const done = checks.total - checks.pending;
    return {
      label: `CI running · ${done}/${checks.total}`,
      tone: "running",
      title: `${checks.pending} of ${checks.total} checks still running.`,
      pulse: true,
    };
  }
  return {
    label: `CI passed · ${checks.total}`,
    tone: "passed",
    title: `All ${checks.total} checks passed.`,
    pulse: false,
  };
}

/** How much of the bottom of the window the board's capture bar is standing on. */
export const CAPTURE_BAR_HEIGHT_VAR = "--kanban-capture-h";

// The capture bar owns the bottom of the window and grows with focus and with
// every attachment, so a fixed offset printed the skill pill through a focused
// phone composer. These spell the variable out because Tailwind only sees class
// strings it can read literally; `captureBarOffsetsReadTheVar` is the tripwire.
export const BOTTOM_ABOVE_CAPTURE_BAR = "bottom-[calc(var(--kanban-capture-h,0px)+1.5rem)]";

/** One row further up, so a status pill clears the archive target as well. */
export const BOTTOM_ABOVE_DROP_ZONE = "bottom-[calc(var(--kanban-capture-h,0px)+6rem)]";
