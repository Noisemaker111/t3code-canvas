/**
 * The single system prompt a Hermes tick sends: what Hermes is, the `board.*`
 * surface, and the current board snapshot.
 *
 * @module kanban/hermes/prompt
 */
import type { HermesRoutingBrief, KanbanCard, ModelSelection } from "@t3tools/contracts";

import { buildBoardApiSurface, buildMcpApiSurface } from "./apiSurface.ts";
import { hermesMcpToolset } from "./mcpRegistry.ts";
import type { BoardPendingInput, BoardProject } from "./boardApi.ts";
import { formatHelperBlock } from "./helpers.ts";
import type { HermesHelper } from "./helperStore.ts";
import { formatJudgmentQueue, type JudgmentItem } from "./judgment.ts";
import { formatJournalBlock, type HermesJournalEntry } from "./journal.ts";
import type { Lesson } from "./knowledgeStore.ts";
import { formatKnowledgeBlock } from "./lessons.ts";
import { formatCardHistoryBlock, type HermesCardHistory } from "./messageContext.ts";
import { projectSlug, projectSlugs } from "./projectRouting.ts";
import { formatHermesRoutingSkills } from "./skills/index.ts";

export type HermesSnapshot = {
  readonly cards: ReadonlyArray<KanbanCard>;
  readonly projects: ReadonlyArray<BoardProject>;
  readonly models: ReadonlyArray<{
    routeId: string;
    selection: ModelSelection;
    instanceId: string;
    model: string;
    costTier: number;
    usable: boolean;
    capability: import("@t3tools/contracts").HermesRouteCapability;
    speed: import("@t3tools/contracts").HermesRouteSpeed;
    capacity: import("@t3tools/contracts").HermesCapacityPool;
    usage: import("@t3tools/contracts").HermesTaskUsageEstimate;
    meteredPrice?: import("@t3tools/contracts").HermesMeteredPrice | null;
    taskCost?: import("@t3tools/contracts").HermesTaskCost | null;
    /** The owner's sentence about what this model is for. Empty when unset. */
    note?: string;
    /** The rule's fixed launch options and owner-approved semantic choices. */
    options?: string;
    optionChoices?: ReadonlyArray<{ id: string; values: ReadonlyArray<string> }>;
  }>;
  readonly pendingInputs: ReadonlyArray<BoardPendingInput>;
  readonly policy: Record<string, unknown>;
  /**
   * What each column does, one line per rule, generated from the components.
   * The prompt states this instead of describing the shipped pipeline in prose.
   */
  readonly boardRules?: ReadonlyArray<string>;
  /** Closing agent report per Active card thread, already parsed upstream. */
  readonly reports: ReadonlyArray<{
    readonly cardId: string;
    readonly threadId: string;
    readonly done: ReadonlyArray<string>;
    readonly remaining: ReadonlyArray<string>;
    readonly blocked: string | null;
    readonly nudges: number;
  }>;
  /**
   * Liveness for every card that has a thread, report or not. This is what
   * tells Hermes a card is sitting rather than working — a thread with no
   * closing report still shows up here.
   */
  readonly threads: ReadonlyArray<{
    readonly cardId: string;
    readonly threadId: string;
    readonly exists: boolean;
    readonly turnState: string;
    readonly idleForMs: number | null;
    readonly messageCount: number;
    readonly lastLine: string | null;
    /**
     * Last few transcript entries for a stopped thread — what [review] judges
     * from. The newest is verbatim, line breaks kept: a question, a fork or a
     * list of options is the decision, and a clip lands in the middle of it.
     * The ones before it are context and stay clipped.
     */
    readonly tail?: ReadonlyArray<string>;
  }>;
  /** Compact per-card abstraction produced before the routing skills run. */
  readonly routingBriefs?: ReadonlyArray<HermesRoutingBrief>;
  /**
   * Helper threads Hermes has out — running ones (whose cards are held back
   * from the queue) and settled ones whose answer has not been read yet.
   */
  readonly helpers?: ReadonlyArray<HermesHelper>;
  /** The only thing the model is asked about. Empty means the tick never ran. */
  readonly judgment?: ReadonlyArray<JudgmentItem>;
  /** What the deterministic pass already did this tick, so the model does not redo it. */
  readonly ruleLog?: ReadonlyArray<string>;
  /**
   * What Hermes already did to each card, exact, from calls that ran. Rendered
   * for the queued cards only, and always in the newest turn — a block that
   * changes must never sit in the cached prefix.
   */
  readonly journal?: ReadonlyArray<HermesJournalEntry>;
  /**
   * Recorded ticks for the cards this turn is about — what Hermes called on
   * each and when. Attached when a message names a card, so "why did you do
   * that" is answered from the log rather than from memory.
   */
  readonly cardHistory?: ReadonlyArray<HermesCardHistory>;
  /** Board operations that keep failing tick after tick, so the loop can see its own breakage. */
  readonly failures?: ReadonlyArray<{
    readonly method: string;
    readonly cardId: string | null;
    readonly count: number;
    readonly error: string;
  }>;
  /**
   * Tooling an agent hit and worked around, or a detector caught failing over
   * and over. Counts only — the bodies live in the friction log, and a block
   * that grew with every sighting would cost more than it tells.
   */
  readonly papercuts?: ReadonlyArray<{
    readonly tool: string;
    readonly scope: string;
    readonly summary: string;
    readonly count: number;
    readonly threads: number;
    readonly workaround: string | null;
  }>;
  /**
   * Pictures and comments a human or a thread addressed to Hermes and nobody
   * has handed over yet. The image itself rides the turn as its own part; this
   * is the caption and where it came from.
   */
  /**
   * What the box has learned and now teaches on every launch. Hermes is shown
   * it so it stops re-teaching what a thread was already told, and so it can
   * retract one that turned out to be wrong.
   */
  readonly knowledge?: ReadonlyArray<Lesson>;
  readonly canvasMessages?: ReadonlyArray<{
    readonly id: string;
    readonly authorKind: string;
    readonly authorId: string | null;
    readonly text: string;
    readonly hasImage: boolean;
  }>;
};

/**
 * The cached prefix, and the only place a standing instruction belongs.
 *
 * Two prices, and they are not the same. This block is a cached prefix — paid
 * about once, and re-paid only when it changes. Everything a *turn* carries is
 * new tokens on every tick, and a per-card line is that times the cards. So the
 * rule that used to head each block in every turn — what ALREADY TRIED is, what
 * to do with a papercut, that a canvas message is shown once — is stated here
 * instead, once, and the turn carries the data under a bare label.
 *
 * What is not here: the argument for a rule, the same rule stated twice, and
 * anything a verb's own doc comment in BOARD API already says. A justification
 * is argued at a model once and then billed on every tick forever.
 */
const RULES = [
  "You are Hermes, the board brain. The mechanical rules already ran this tick — BOARD RULES is",
  "what they do on this board. NEEDS A DECISION is what is left for you; work those and nothing else.",
  "",
  "Rules:",
  "- [structure] / [route] Run the routing skills below against the card's ROUTING BRIEF and call",
  "  applyLaunchPlan once — never another verb for a routing decision. Project pick: prefer",
  "  PROJECT KEYWORD MATCHES / brief project `keyword hits` (cheap name/path greps) when one",
  "  project owns the obvious tokens; still call searchProjects only if ambiguous. Do not load",
  "  full README/AGENTS.md for routing. `duplicate of …` on the queue line → archiveCard this",
  "  one, naming what it repeats. `overlaps …` → leave it unstructured and note() the conflict.",
  "  A body that is only an issue or PR link is a claim: reproduce it first, or askHelper — not",
  "  prepStatus ready. Look at any image on this ask.",
  "- [review] Judge from THREADS, threadTranscript for more; a DONE/REMAINING report is a hint,",
  "  not the truth. Finished → finishCard. Stopped short → nudgeThread with the next concrete",
  "  step. Stopped to ask → answer that question from its whole closing in THREADS, not the queue",
  "  line's clip: nudgeThread when the closing, the card and PROJECTS settle it, askUser when only",
  "  the human can. Past maxNudgesPerCard prefer a different decision to the same nudge. Thread",
  '  gone → updateCard back to intake; obsolete → archiveCard. "I do not know what this card is"',
  "  is not an outcome.",
  "- [message] reply() with the whole answer this turn; you are not shown it again. Answer about a",
  "  past decision from CARD HISTORY and ALREADY TRIED, or say it is not in them. A message that",
  "  answers an askUser in ALREADY TRIED completes that card's decision now.",
  "- [helper] / [blocked] / [answer] Act this turn: the helper's answer is in HELPERS, and a",
  "  blocked thread is answered with one of its own options.",
  "- askHelper is for a fact inside a known project, askUser for a choice only the human can make.",
  "  Never a helper to guess intent, never note() in place of a blocking question.",
  "- Learn instead of repeating yourself: a correction you have given twice, or a convention the",
  "  owner had to state, is learn() once and then rides every launch into that project. Anything a",
  "  card disproves is forget() with the reason.",
  "- Never merge a PR by hand, never do the work of a rule missing from BOARD RULES, never guard a",
  "  verb or re-list the board. note() at most once, for what counters cannot say.",
  "",
  "The turn's blocks:",
  "- ALREADY TRIED / CARD HISTORY — your own past calls, exact. A call listed as failed fails the",
  "  same way again.",
  "- HELPERS and CANVAS MESSAGES are shown once: act on them in the turn they appear.",
  "- PAPERCUTS — tooling that broke under an agent. Hand a thread the workaround rather than",
  "  nudging it to re-fight a known-broken tool. A fix card is filed for you.",
  "- KNOWLEDGE — facts every launch into that project already carries, so never nudge one.",
  "- BOARD FAILURES — calls failing tick after tick. Triage the card instead of retrying.",
  "- The rest is state, not work. A quoted MODELS rule is the owner's instruction for that model.",
  "",
  "Answer with ONE JavaScript program in a ```js fence and nothing else.",
  "It runs in Executor's isolated QuickJS sandbox with only `board`, `console` and `deadline`.",
  "No require, no import, no fetch, no process. Top-level await is available.",
].join("\n");

/**
 * One THREADS entry. The full snapshot carries idle time; the delta turn does
 * not, because it already says what changed. Everything else is the same block,
 * and it is the same block on purpose — this is what [review] judges from, so
 * the two turns must not show the model different amounts of the thread.
 *
 * The tail's newest entry arrives verbatim and keeps its line breaks, so every
 * line of it is indented rather than the first one only. A closing that lays
 * out two options as two lines has to still read as two options.
 */
function threadBlock(thread: HermesSnapshot["threads"][number], withIdle: boolean): string {
  const idle = thread.idleForMs === null ? "?" : `${Math.round(thread.idleForMs / 60_000)}m`;
  const line = [
    `- card=${thread.cardId} thread=${thread.threadId}`,
    thread.exists ? `turn=${thread.turnState}` : "turn=MISSING (thread is gone)",
    ...(withIdle ? [`idle=${idle}`] : []),
    `messages=${thread.messageCount}`,
  ].join(" ");

  if (thread.tail && thread.tail.length > 0) {
    const tail = thread.tail
      .map((entry) =>
        entry
          .split("\n")
          .map((entryLine) => `  | ${entryLine}`)
          .join("\n"),
      )
      .join("\n");
    return `${line}\n${tail}`;
  }
  return thread.lastLine ? `${line}\n  last: ${JSON.stringify(thread.lastLine)}` : line;
}

function cardLine(card: KanbanCard): string {
  const parts = [
    `${card.id} [${card.at}]`,
    JSON.stringify(card.title.slice(0, 120)),
    `project=${card.projectId ?? "-"}`,
    `thread=${card.threadId ?? "-"}`,
    `prep=${card.prepStatus}`,
  ];
  if (card.prUrl) parts.push(`pr=${card.prUrl}`);
  if (card.modelSelection) {
    parts.push(`model=${String(card.modelSelection.instanceId)}/${card.modelSelection.model}`);
  }
  const attachments = card.attachments ?? [];
  if (attachments.length > 0) {
    const kept = attachments.filter((entry) => entry.include !== false).length;
    parts.push(`attachments=${attachments.length} keep=${kept}`);
  }
  return `- ${parts.join(" ")}`;
}

function bodyBlock(card: KanbanCard): string {
  const body = card.body.trim();
  const attachments = card.attachments ?? [];
  const attachmentLines =
    attachments.length === 0
      ? ""
      : [
          "",
          "Attachments:",
          ...attachments.map((entry) => {
            const flag = entry.include === false ? "drop" : "keep";
            return `- ${entry.id} [${entry.kind}/${flag}] ${entry.name} (${entry.mimeType}, ${entry.sizeBytes}B)`;
          }),
        ].join("\n");
  if (!body && !attachmentLines) return "";
  const clipped = body.length > 1200 ? `${body.slice(0, 1200)}…` : body;
  return `\n### ${card.id}\n${clipped}${attachmentLines}\n`;
}

const JOURNAL_HEADER = "## ALREADY TRIED";

function queuedCardIds(snapshot: HermesSnapshot): ReadonlySet<string> {
  return new Set(
    (snapshot.judgment ?? [])
      .map((item) => item.cardId)
      .filter((cardId): cardId is string => cardId !== null),
  );
}

function journalSection(
  snapshot: HermesSnapshot,
  cardIds: ReadonlySet<string>,
): ReadonlyArray<string> {
  const block = formatJournalBlock(snapshot.journal ?? [], cardIds);
  return block === null ? [] : [JOURNAL_HEADER, block];
}

const CARD_HISTORY_HEADER = "## CARD HISTORY";

function cardHistorySection(snapshot: HermesSnapshot): ReadonlyArray<string> {
  const block = formatCardHistoryBlock(snapshot.cardHistory ?? []);
  return block === null ? [] : [CARD_HISTORY_HEADER, block];
}

function helpersSection(snapshot: HermesSnapshot): ReadonlyArray<string> {
  const block = formatHelperBlock(snapshot.helpers ?? []);
  return block === null ? [] : ["## HELPERS", block];
}

/**
 * Slug first, id last: a projectId is written by name here, and a raw UUID is
 * the one thing a card can never confirm. Every line carries repo and root, so
 * a card naming either is already routed.
 */
export function projectsBlock(snapshot: HermesSnapshot): string {
  if (snapshot.projects.length === 0) return "(none — do not launch)";
  const slugs = projectSlugs(snapshot.projects);
  return snapshot.projects
    .map((project) => {
      const slug = slugs.get(project.id) ?? projectSlug(project);
      return [
        `- ${slug}`,
        `repo=${project.repo ?? "-"}`,
        `root=${project.workspaceRoot ?? "-"}`,
        `id=${project.id}`,
      ].join(" ");
    })
    .join("\n");
}

function papercutsSection(snapshot: HermesSnapshot): ReadonlyArray<string> {
  const papercuts = snapshot.papercuts ?? [];
  if (papercuts.length === 0) return [];
  return [
    "## PAPERCUTS",
    [
      ...papercuts.map((papercut) => {
        const threads = papercut.threads > 1 ? `, ${papercut.threads} threads` : "";
        const workaround = papercut.workaround ? ` — workaround: ${papercut.workaround}` : "";
        return `- ${papercut.tool} (${papercut.scope}) ${papercut.count}×${threads}: ${papercut.summary}${workaround}`;
      }),
    ].join("\n"),
  ];
}

function knowledgeSection(snapshot: HermesSnapshot): ReadonlyArray<string> {
  const block = formatKnowledgeBlock(snapshot.knowledge ?? []);
  return block === null ? [] : ["## KNOWLEDGE", block];
}

export function buildHermesSnapshotBlock(snapshot: HermesSnapshot): string {
  const sections: string[] = [];
  const queued = queuedCardIds(snapshot);

  if (snapshot.judgment && snapshot.judgment.length > 0) {
    sections.push("## NEEDS A DECISION", formatJudgmentQueue(snapshot.judgment));
  }

  sections.push(...helpersSection(snapshot));
  sections.push(...journalSection(snapshot, queued));
  sections.push(...cardHistorySection(snapshot));

  if (snapshot.ruleLog && snapshot.ruleLog.length > 0) {
    sections.push("## RULES ALREADY RAN", snapshot.ruleLog.map((line) => `- ${line}`).join("\n"));
  }

  if (snapshot.failures && snapshot.failures.length > 0) {
    sections.push(
      "## BOARD FAILURES",
      [
        ...snapshot.failures.map(
          (failure) =>
            `- ${failure.method} on ${failure.cardId ?? "(board)"} failed ${failure.count}× — ${failure.error.slice(0, 200)}`,
        ),
      ].join("\n"),
    );
  }

  sections.push(...papercutsSection(snapshot));
  sections.push(...knowledgeSection(snapshot));

  if (snapshot.canvasMessages && snapshot.canvasMessages.length > 0) {
    sections.push(
      "## CANVAS MESSAGES",
      [
        ...snapshot.canvasMessages.map((message) => {
          const from = message.authorId
            ? `${message.authorKind} ${message.authorId}`
            : message.authorKind;
          const picture = message.hasImage ? " [picture attached]" : "";
          return `- from ${from}${picture}: ${message.text || "(no comment)"}`;
        }),
      ].join("\n"),
    );
  }

  // What every column this board has does, generated from the rules the tick
  // dispatches. This replaced a paragraph of prose that a board which had
  // switched anything off silently contradicted, and which said nothing about a
  // column somebody added. POLICY stays for the numbers — nudge caps, windows —
  // which are settings, not behavior.
  if (snapshot.boardRules && snapshot.boardRules.length > 0) {
    sections.push("## BOARD RULES", snapshot.boardRules.join("\n"));
  }

  sections.push("## POLICY", JSON.stringify(snapshot.policy, null, 2));

  if (snapshot.routingBriefs && snapshot.routingBriefs.length > 0) {
    sections.push(
      "## ROUTING BRIEFS",
      snapshot.routingBriefs.map((brief) => JSON.stringify(brief)).join("\n"),
    );
  }

  if (!snapshot.routingBriefs || snapshot.routingBriefs.length === 0) {
    sections.push("## PROJECTS", projectsBlock(snapshot));
  }

  if (!snapshot.routingBriefs || snapshot.routingBriefs.length === 0)
    sections.push(
      "## MODELS",
      snapshot.models.length === 0
        ? "(none ready)"
        : [
            ...snapshot.models.map((model) => {
              const note = model.note?.trim() ? ` — "${model.note.trim()}"` : "";
              const options = model.options?.trim() ? ` [${model.options.trim()}]` : "";
              return `- ${model.instanceId}/${model.model} cost=${"$".repeat(Math.max(1, model.costTier))}${model.usable ? "" : " (exhausted)"}${options}${note}`;
            }),
          ].join("\n"),
    );

  sections.push(
    "## BOARD",
    snapshot.cards.length === 0 ? "(empty)" : snapshot.cards.map(cardLine).join("\n"),
  );

  // Only the cards the model was asked about. A body it cannot act on is
  // input tokens that buy nothing.
  const routed = new Set((snapshot.routingBriefs ?? []).map((brief) => brief.cardId));
  const bodies = snapshot.cards
    .filter((card) => !routed.has(card.id as string))
    .filter((card) => (queued.size > 0 ? queued.has(card.id as string) : card.at === "prompts"))
    .map(bodyBlock)
    .filter((block) => block.length > 0)
    .join("");
  if (bodies) sections.push("## CARD BODIES", bodies.trim());

  if (snapshot.reports.length > 0) {
    sections.push(
      "## AGENT REPORTS",
      snapshot.reports
        .map((report) =>
          [
            `- card=${report.cardId} thread=${report.threadId} nudges=${report.nudges}`,
            `  done: ${report.done.join("; ") || "(nothing reported)"}`,
            `  remaining: ${report.remaining.join("; ") || "none"}`,
            ...(report.blocked ? [`  blocked: ${report.blocked}`] : []),
          ].join("\n"),
        )
        .join("\n"),
    );
  }

  if (snapshot.threads.length > 0) {
    sections.push(
      "## THREADS",
      snapshot.threads.map((thread) => threadBlock(thread, true)).join("\n"),
    );
  }

  if (snapshot.pendingInputs.length > 0) {
    sections.push(
      "## PENDING QUESTIONS",
      snapshot.pendingInputs
        .map(
          (pending) =>
            `- thread=${pending.threadId} request=${pending.requestId} q=${JSON.stringify(pending.question)} options=${JSON.stringify(pending.options)}`,
        )
        .join("\n"),
    );
  }

  return sections.join("\n\n");
}

/** Compact per-card state, the unit of "did anything change" for delta turns. */
export function boardDigestOf(snapshot: HermesSnapshot): Record<string, string> {
  const digest: Record<string, string> = {};
  for (const card of snapshot.cards) {
    if (card.archivedAt) continue;
    digest[card.id as string] =
      `${card.at}|${card.title.slice(0, 80)}|t=${card.threadId ?? "-"}|prep=${card.prepStatus}|pr=${card.prUrl ?? "-"}`;
  }
  return digest;
}

/**
 * The follow-up user turn: only what moved since the last tick. The full
 * snapshot already rode in the conversation's first turn; re-sending it every
 * tick is the cost this block exists to avoid.
 */
export function buildHermesDeltaBlock(
  snapshot: HermesSnapshot,
  previous: Record<string, string>,
): string {
  const sections: string[] = [];
  const current = boardDigestOf(snapshot);

  const changes: string[] = [];
  for (const card of snapshot.cards) {
    if (card.archivedAt) continue;
    const id = card.id as string;
    const before = previous[id];
    if (before === undefined) changes.push(`- appeared: ${cardLine(card).slice(2)}`);
    else if (before !== current[id]) changes.push(`- changed: ${cardLine(card).slice(2)}`);
  }
  for (const id of Object.keys(previous)) {
    if (current[id] === undefined) changes.push(`- gone: ${id} (done or archived)`);
  }
  sections.push(
    "## BOARD CHANGES (since your last turn)",
    changes.length === 0 ? "(no card changes)" : changes.join("\n"),
  );

  const queuedCards = queuedCardIds(snapshot);
  if (snapshot.judgment && snapshot.judgment.length > 0) {
    sections.push("## NEEDS A DECISION", formatJudgmentQueue(snapshot.judgment));
  }
  sections.push(...helpersSection(snapshot));
  sections.push(...journalSection(snapshot, queuedCards));
  sections.push(...cardHistorySection(snapshot));
  if (snapshot.ruleLog && snapshot.ruleLog.length > 0) {
    sections.push("## RULES ALREADY RAN", snapshot.ruleLog.map((line) => `- ${line}`).join("\n"));
  }
  if (snapshot.failures && snapshot.failures.length > 0) {
    sections.push(
      "## BOARD FAILURES",
      snapshot.failures
        .map(
          (failure) =>
            `- ${failure.method} on ${failure.cardId ?? "(board)"} failed ${failure.count}× — ${failure.error.slice(0, 200)}`,
        )
        .join("\n"),
    );
  }

  sections.push(...papercutsSection(snapshot));
  sections.push(...knowledgeSection(snapshot));

  if (snapshot.canvasMessages && snapshot.canvasMessages.length > 0) {
    sections.push(
      "## CANVAS MESSAGES",
      snapshot.canvasMessages
        .map((message) => {
          const from = message.authorId
            ? `${message.authorKind} ${message.authorId}`
            : message.authorKind;
          const picture = message.hasImage ? " [picture attached]" : "";
          return `- from ${from}${picture}: ${message.text || "(no comment)"}`;
        })
        .join("\n"),
    );
  }

  // Bodies only for queued cards the history has not seen in this state.
  const queued = new Set((snapshot.judgment ?? []).map((item) => item.cardId));
  const bodies = snapshot.cards
    .filter((card) => queued.has(card.id as string) && previous[card.id as string] === undefined)
    .map(bodyBlock)
    .filter((block) => block.length > 0)
    .join("");
  if (bodies) sections.push("## CARD BODIES", bodies.trim());

  if (snapshot.reports.length > 0) {
    sections.push(
      "## AGENT REPORTS",
      snapshot.reports
        .map(
          (report) =>
            `- card=${report.cardId} thread=${report.threadId} nudges=${report.nudges} done: ${report.done.join("; ") || "(nothing reported)"} remaining: ${report.remaining.join("; ") || "none"}${report.blocked ? ` blocked: ${report.blocked}` : ""}`,
        )
        .join("\n"),
    );
  }

  const reviewed = new Set(
    (snapshot.judgment ?? []).filter((item) => item.threadId !== null).map((item) => item.threadId),
  );
  const threads = snapshot.threads.filter((thread) => reviewed.has(thread.threadId));
  if (threads.length > 0) {
    sections.push("## THREADS", threads.map((thread) => threadBlock(thread, false)).join("\n"));
  }

  if (snapshot.pendingInputs.length > 0) {
    sections.push(
      "## PENDING QUESTIONS",
      snapshot.pendingInputs
        .map(
          (pending) =>
            `- thread=${pending.threadId} request=${pending.requestId} q=${JSON.stringify(pending.question)} options=${JSON.stringify(pending.options)}`,
        )
        .join("\n"),
    );
  }

  return sections.join("\n\n");
}

export function buildHermesSystemPrompt(): string {
  const sections = [
    RULES,
    "",
    "## ROUTING SKILLS",
    formatHermesRoutingSkills(),
    "",
    "## BOARD API",
    "```ts",
    buildBoardApiSurface(),
    "```",
  ];
  const mcp = buildMcpApiSurface(hermesMcpToolset());
  if (mcp.length > 0) {
    sections.push(
      "",
      "## MCP API",
      "Raw tools from the owner's MCP servers. They carry no board guards — a",
      "board change is still made with board.*. Calls count against the same",
      "per-tick call limit.",
      "```ts",
      mcp,
      "```",
    );
  }
  return sections.join("\n");
}

/** Feed a rejected program back so the retry fixes it instead of re-guessing. */
export function buildRetryUserPrompt(input: {
  readonly snapshotBlock: string;
  readonly badSource: string;
  readonly error: string;
}): string {
  return [
    input.snapshotBlock,
    "",
    "## YOUR PREVIOUS ANSWER FAILED",
    "```js",
    input.badSource.slice(0, 4000),
    "```",
    `Error: ${input.error}`,
    "Answer again with one corrected JavaScript program in a ```js fence. Nothing else.",
  ].join("\n");
}
