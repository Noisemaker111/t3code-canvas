import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  HermesBrainStatus,
  HermesPreflightStatus,
  HermesTickLogEntry,
  HermesTickTranscript,
  HermesTier,
} from "@t3tools/contracts";
import { DEFAULT_HERMES_BRAIN_MODEL, ProviderInstanceId } from "@t3tools/contracts";
import { boardRulePolicy, hermesPipelinePatch } from "@t3tools/shared/boardRules";
import { resolveHermesTransport } from "@t3tools/shared/hermesTransport";
import {
  ActivityIcon,
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ListIcon,
  PlayIcon,
  PlugIcon,
  RefreshCwIcon,
  HeartPulseIcon,
  ScrollTextIcon,
  WrenchIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  configureHermesBrain,
  fetchHermesBrainStatus,
  fetchHermesTick,
  resetHermesBrainConversation,
  runHermesBrainDryRun,
  runHermesBrainTick,
  HERMES_TIER_HINTS,
  HERMES_TIER_LABELS,
} from "../../lib/hermesBrain";
import {
  applyServerHermesBrainConfig,
  readBoardSettings,
  subscribeBoardSettings,
  updateBoardSettings,
  type BoardSettings,
} from "../../lib/boardSettings";
import { describeHermesChip } from "../../lib/hermesChip";
import { usePrimaryEnvironment } from "../../state/environments";
import { useKanbanCards } from "../../state/kanban";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import type { ModelEsque } from "../chat/providerIconUtils";
import { useProviderInstancePicker } from "./InstanceModelSelect";
import { HermesBudgetPanel } from "./HermesBudgetPanel";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  SettingResetButton,
  settingsPageShell,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";

const STATUS_POLL_MS = 5_000;
const INTERVAL_CHOICES = [30, 60, 120, 300, 600];

/** `ceiling` is the one worth noticing: it means a card never left the queue. */
const EVICTION_REASON_LABELS: Record<"settled" | "resolved" | "ceiling", string> = {
  settled: "Cut when the board settled",
  resolved: "Dropped decisions that closed",
  ceiling: "Hit the token backstop with a card still undecided",
};

function relativeTime(iso: string, nowMs: number): string {
  const deltaMs = nowMs - new Date(iso).getTime();
  if (!Number.isFinite(deltaMs)) return iso;
  const seconds = Math.round(Math.abs(deltaMs) / 1000);
  const value =
    seconds < 60
      ? `${seconds}s`
      : seconds < 3600
        ? `${Math.round(seconds / 60)}m`
        : `${Math.round(seconds / 3600)}h`;
  return deltaMs >= 0 ? `${value} ago` : `in ${value}`;
}

function clockTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString();
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function tokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** Sub-cent ticks are the normal case, so two decimals would read as free. */
function usd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** One line of what a tick cost. Tiers that report no usage say so. */
function CostLine({ cost }: { cost: NonNullable<HermesTickTranscript["cost"]> }) {
  const usage = cost.usage;
  return (
    <p className="text-[11px] text-muted-foreground">
      {cost.modelCalls === 0
        ? "No model call"
        : `${cost.modelCalls} model call${cost.modelCalls === 1 ? "" : "s"}`}
      {" · "}
      {tokens(cost.promptChars)} prompt chars ({tokens(cost.snapshotChars)} board)
      {cost.historyTokens !== undefined
        ? ` · ≈${tokens(cost.historyTokens)} history / ≈${tokens(cost.deltaTokens ?? 0)} delta tok`
        : ""}
      {" · "}
      {duration(cost.modelMs)} model / {duration(cost.executionMs)} board
      {usage
        ? ` · ${tokens(usage.inputTokens)} in (${tokens(usage.cachedInputTokens)} cached) / ${tokens(usage.outputTokens)} out${usage.usd === undefined ? "" : ` · ${usd(usage.usd)}`}`
        : cost.modelCalls > 0
          ? " · tier reports no token usage"
          : ""}
    </p>
  );
}

function tierDetail(tier: HermesBrainStatus["tiers"][number]): string {
  if (!tier.enabled) return `off — ${tier.detail}`;
  return tier.available ? `ready — ${tier.detail}` : tier.detail;
}

function Dot({ tone }: { tone: "ready" | "down" | "off" }) {
  const color =
    tone === "ready"
      ? "bg-emerald-500"
      : tone === "down"
        ? "bg-amber-500"
        : "bg-muted-foreground/40";
  return <span className={`inline-block size-1.5 shrink-0 rounded-full ${color}`} aria-hidden />;
}

function NumberInput({
  label,
  value,
  min,
  step,
  suffix,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  step: number;
  suffix: string;
  onCommit: (next: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        aria-label={label}
        min={min}
        step={step}
        className="h-8 w-20 rounded-md bg-raised px-2 text-xs tabular-nums outline-none focus:border-ring"
        value={value}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (!Number.isFinite(next)) return;
          onCommit(Math.max(min, Math.floor(next)));
        }}
      />
      <span className="text-xs text-muted-foreground">{suffix}</span>
    </div>
  );
}

function Transcript({ tick }: { tick: HermesTickTranscript }) {
  return (
    <div className="space-y-2 text-xs">
      {tick.attempts.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5 font-mono text-[10px] text-muted-foreground">
          {tick.attempts.map((attempt, index) => (
            <li key={`${attempt.tier}-${index}`} className="rounded bg-muted/50 px-1.5 py-0.5">
              {attempt.tier}: {attempt.outcome}
              {attempt.durationMs === undefined ? "" : ` ${duration(attempt.durationMs)}`}
              {attempt.detail && attempt.detail !== "ok" ? ` (${attempt.detail})` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {tick.cost ? <CostLine cost={tick.cost} /> : null}
      {tick.error ? <p className="text-destructive">{tick.error}</p> : null}
      {tick.program ? (
        <pre className="max-h-64 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
          {tick.program}
        </pre>
      ) : null}
      {tick.calls.length > 0 ? (
        <ul className="space-y-1 font-mono text-[11px]">
          {tick.calls.map((call, index) => (
            <li key={`${call.method}-${index}`} className="flex flex-wrap gap-1.5">
              <span className="font-semibold">{call.method}</span>
              <span className="text-muted-foreground">{JSON.stringify(call.args)}</span>
              {call.durationMs !== undefined && call.durationMs >= 250 ? (
                <span className="text-muted-foreground">{duration(call.durationMs)}</span>
              ) : null}
              {call.skipped ? <span className="text-amber-600">(not written)</span> : null}
              {call.error ? <span className="text-destructive">{call.error}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {tick.logs.length > 0 ? (
        <pre className="max-h-40 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px]">
          {tick.logs.join("\n")}
        </pre>
      ) : null}
    </div>
  );
}

/** `Jul 28, 17:46:43.143` — a log reads down the column, so the shape is fixed. */
function logTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = date.toLocaleTimeString(undefined, { hour12: false });
  return `${day}, ${time}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function tickFunction(entry: HermesTickLogEntry): string {
  if (entry.recordOnly) return "hermes:dryRun";
  if (entry.modelSkipped === true) return "hermes:rulePass";
  if (entry.trigger === "wake") return "hermes:wake";
  if (entry.trigger === "manual") return "hermes:runNow";
  return "hermes:tick";
}

const LOG_GRID = "grid grid-cols-[auto_10.5rem_4rem_4.5rem_6.5rem_minmax(0,1fr)] items-center";

function shortTickId(id: string): string {
  const tail = id.split(/[-_]/).at(-1) ?? id;
  return tail.length > 6 ? tail.slice(-6) : tail;
}

function LogHeader() {
  return (
    <li
      className={`${LOG_GRID} gap-2 border-b border-border/60 px-4 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground sm:px-5`}
    >
      <span className="size-3.5" aria-hidden />
      <span>Timestamp</span>
      <span>ID</span>
      <span>Status</span>
      <span>Duration</span>
      <span>Function</span>
    </li>
  );
}

function LogRow({ entry, nowMs }: { entry: HermesTickLogEntry; nowMs: number }) {
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState<HermesTickTranscript | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const toggle = useCallback(() => {
    setOpen((previous) => {
      const next = !previous;
      if (next && !tick) {
        fetchHermesTick(entry.id).then(setTick, (cause: Error) => setLoadError(cause.message));
      }
      return next;
    });
  }, [entry.id, tick]);

  const failed = entry.error !== null;

  return (
    <li className="border-t border-border/40 first:border-t-0">
      <button
        type="button"
        onClick={toggle}
        title={relativeTime(entry.ranAt, nowMs)}
        className={`${LOG_GRID} w-full gap-2 px-4 py-1 text-left font-mono text-[11px] hover:bg-accent/40 sm:px-5`}
      >
        {open ? (
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="tabular-nums text-muted-foreground">{logTimestamp(entry.ranAt)}</span>
        <span className="truncate rounded bg-muted px-1 text-[10px] text-muted-foreground">
          {shortTickId(entry.id)}
        </span>
        <span className={failed ? "text-destructive" : "text-emerald-600 dark:text-emerald-400"}>
          {failed ? "failed" : "success"}
        </span>
        <span className="truncate tabular-nums text-muted-foreground">
          {duration(entry.durationMs)} · {entry.writeCount}/{entry.callCount}
        </span>
        <span className="truncate">
          <span className="text-foreground">{tickFunction(entry)}</span>{" "}
          <span className="text-muted-foreground">{entry.error ?? entry.summary}</span>
        </span>
      </button>
      {open ? (
        <div className="px-4 pb-3 pl-11 sm:px-5 sm:pl-12">
          {loadError ? (
            <p className="text-xs text-destructive">{loadError}</p>
          ) : tick ? (
            <Transcript tick={tick} />
          ) : (
            <p className="text-xs text-muted-foreground">Loading transcript…</p>
          )}
        </div>
      ) : null}
    </li>
  );
}

const CHIP_TONE_CLASS = {
  good: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  working: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  warn: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  bad: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300",
} as const;

/**
 * Same words as the board chip, so the two surfaces can never disagree — plus
 * the retry. A failed tick used to leave the user with a red chip and no way to
 * run another one without opening Advanced → Tick log.
 */
function LoopState({
  nowMs,
  onRunTick,
  running,
}: {
  nowMs: number;
  onRunTick: () => void;
  running: boolean;
}) {
  const { hermes } = useKanbanCards();
  if (!hermes) return null;
  const state = hermes.enabled
    ? describeHermesChip(hermes, nowMs)
    : ({
        label: "Hermes off",
        detail: null,
        tone: "warn",
        title: "Nothing ticks until the switch is on.",
      } as const);
  const failed = hermes.enabled && hermes.consecutiveFailures > 0;
  return (
    <div
      className={`mx-4 mb-3 mt-3.5 rounded-lg border px-3 py-2 text-xs sm:mx-5 ${CHIP_TONE_CLASS[state.tone]}`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <span className="font-medium">{state.label}</span>
          {state.detail ? <span className="opacity-80"> · {state.detail}</span> : null}
          <p className="mt-0.5 text-[11px] opacity-80">{state.title}</p>
        </div>
        <Button
          size="xs"
          variant="outline"
          className="shrink-0 bg-background/60"
          disabled={running || !hermes.enabled || hermes.busy}
          onClick={onRunTick}
        >
          <RefreshCwIcon className={running ? "size-3 animate-spin" : "size-3"} />
          {failed ? "Retry tick" : "Run tick now"}
        </Button>
      </div>
    </div>
  );
}

/**
 * "On" and "ticking" are different failures and must read differently — the one
 * that used to say "Idle — no ticks scheduled" for both is what made a stalled
 * loop look like a switch the user had forgotten to flip.
 */
export function enableStatusLine(
  status: HermesBrainStatus | null,
  requested: boolean | null,
  nowMs: number,
): string {
  if (requested !== null) return requested ? "Starting the loop…" : "Stopping the loop…";
  if (!status) return "Checking the loop…";
  if (!status.enabled) return "Off — nothing ticks until the switch is on.";
  if (!status.running) {
    return "On, but no tick is scheduled — the loop is not running. journalctl -u t3j has why.";
  }
  const next = status.nextTickAt ? relativeTime(status.nextTickAt, nowMs) : "soon";
  const checked = status.lastHeartbeatAt
    ? ` · checked ${relativeTime(status.lastHeartbeatAt, nowMs)}`
    : "";
  const model = status.lastSkipReason
    ? ` · model skipped: ${status.lastSkipReason}`
    : status.lastModelAt
      ? ` · model ${relativeTime(status.lastModelAt, nowMs)}`
      : "";
  return `Watching · next ${next}${checked}${model}`;
}

/**
 * The check pass Hermes runs before it spends anything. A failing critical check
 * is why the loop is watching and moving nothing, so it says which one — the
 * failure it prevents is a card that runs to completion and then cannot open its
 * pull request.
 */
export function preflightStatusLine(
  preflight: HermesPreflightStatus | null | undefined,
  nowMs: number,
): string {
  if (preflight === null || preflight === undefined) {
    return "Not checked yet — the loop checks the box before its first tick.";
  }
  const when = relativeTime(preflight.at, nowMs);
  if (preflight.ok) return `Box is fit to work · checked ${when}`;
  return `Blocked by ${preflight.checkId ?? "a box check"} — ${preflight.detail ?? "no detail"} (${when})`;
}

/**
 * Last status this tab saw. The panel unmounts on every settings-tab switch, and
 * a fresh `null` rendered the switch as off until the fetch landed — a settings
 * screen that reports the opposite of the truth for half a second.
 */
let lastKnownStatus: HermesBrainStatus | null = null;

export function HermesSettingsPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const [status, setStatusState] = useState<HermesBrainStatus | null>(() => lastKnownStatus);
  const [board, setBoard] = useState<BoardSettings>(() => readBoardSettings());
  useEffect(() => subscribeBoardSettings(setBoard), []);
  const patchBoard = useCallback((partial: Partial<BoardSettings>) => {
    setBoard(updateBoardSettings(partial));
  }, []);
  // The rule rows own these four; the panel and the rules dialog write the
  // same place, so a toggle here is the same edit as deleting the row there.
  const pipeline = boardRulePolicy(board);
  // The board chip reads the WS status, not this fetch; without a refresh it
  // keeps saying "Hermes off" next to a switch that is already on.
  const { refresh: refreshBoard } = useKanbanCards();
  // Through a ref: `refresh` is not identity-stable, and a changing `setStatus`
  // would restart the poll interval on every render.
  const refreshBoardRef = useRef(refreshBoard);
  refreshBoardRef.current = refreshBoard;
  const setStatus = useCallback((next: HermesBrainStatus) => {
    lastKnownStatus = next;
    setStatusState(next);
    setBoard(applyServerHermesBrainConfig(next));
    refreshBoardRef.current();
  }, []);
  /** The value the user just asked for, until the server confirms it. */
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(false);
  const picker = useProviderInstancePicker();
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const nowMs = useRelativeTimeTick();

  const load = useCallback(
    () =>
      fetchHermesBrainStatus().then(
        (next) => {
          setStatus(next);
          setError(null);
        },
        (cause: Error) => setError(cause.message),
      ),
    [setStatus],
  );

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const fail = useCallback((title: string, cause: Error) => {
    toastManager.add(stackedThreadToast({ type: "error", title, description: cause.message }));
  }, []);

  // Same run as Settings → System, reachable from where you notice the loop is
  // parked: every check it repairs is one the board would otherwise hit at the
  // end of a card, with the tokens already spent.
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const runHealth = useAtomCommand(serverEnvironment.vpsRunHealth, { reportFailure: false });
  const [fixingBox, setFixingBox] = useState(false);
  const fixBox = useCallback(() => {
    if (environmentId === null) return;
    setFixingBox(true);
    void (async () => {
      const result = await runHealth({ environmentId, input: { fix: true } });
      setFixingBox(false);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          fail(
            "Could not fix the box",
            failure instanceof Error ? failure : new Error("The health run failed."),
          );
        }
        return;
      }
      const repaired = result.value.checks.filter((check) => check.fixed === true);
      const failing = result.value.checks.filter((check) => check.status === "fail");
      toastManager.add({
        type: failing.length > 0 ? "error" : repaired.length > 0 ? "success" : "info",
        title:
          failing.length > 0
            ? `Still failing: ${failing.map((check) => check.id).join(", ")}`
            : repaired.length > 0
              ? `Fixed ${repaired.map((check) => check.id).join(", ")}`
              : "Box is already clean",
      });
      // The loop's own verdict is cached for 30s; this reads the next pass.
      void load();
    })();
  }, [environmentId, fail, load, runHealth]);

  const patch = useCallback(
    (payload: Parameters<typeof configureHermesBrain>[0]) => {
      setBusy(true);
      configureHermesBrain(payload)
        .then(setStatus)
        .catch((cause: Error) => fail("Could not update Hermes", cause))
        .finally(() => setBusy(false));
    },
    [fail, setStatus],
  );

  /** The switch answers the click, not the round trip; a failure snaps it back. */
  const setEnabled = useCallback(
    (checked: boolean) => {
      setPendingEnabled(checked);
      setBusy(true);
      configureHermesBrain({ enabled: checked })
        .then(setStatus)
        .catch((cause: Error) => fail("Could not update Hermes", cause))
        .finally(() => {
          setPendingEnabled(null);
          setBusy(false);
        });
    },
    [fail, setStatus],
  );

  const tiers = status?.tiers ?? [];
  const provider = status?.provider ?? null;
  const transports = useMemo(() => status?.transports ?? [], [status?.transports]);

  const modelOptionsByInstance = useMemo(() => {
    const out = new Map<ProviderInstanceId, ReadonlyArray<ModelEsque>>();
    for (const entry of picker.instances) out.set(entry.instanceId, picker.modelOptionsFor(entry));
    return out;
  }, [picker]);

  // Two refusals, one picker: the provider itself being unusable, and the
  // brain having no transport for it. The second one is the whole point of
  // asking the server for its claims — picking a model Hermes cannot drive
  // used to be silent and then failed every tick.
  const getModelDisabledReason = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      const entry = picker.findInstance(instanceId);
      if (!entry) return null;
      const { selectable, suffix } = picker.instanceLabel(entry);
      if (!selectable) return suffix.replace(/^\s*[—-]\s*/u, "").trim() || "Unavailable";
      // A server built before it published its claims says nothing about
      // transports; refusing every model on that silence would be worse.
      if (transports.length === 0) return null;
      return resolveHermesTransport({
        selection: { instanceId, model },
        drivers: { [instanceId]: entry.driverKind },
        transports,
      }).reason;
    },
    [picker, transports],
  );

  const recheck = useCallback(() => {
    setProbing(true);
    void load().finally(() => setProbing(false));
  }, [load]);

  const runTick = useCallback(
    (mode: "dry" | "real") => {
      setBusy(true);
      (mode === "dry" ? runHermesBrainDryRun() : runHermesBrainTick())
        .then(() => load())
        .catch((cause: Error) => fail(mode === "dry" ? "Dry run failed" : "Tick failed", cause))
        .finally(() => setBusy(false));
    },
    [fail, load],
  );

  const servedTotal = useMemo(
    () => (status?.stats.servedByTier ?? []).reduce((sum, entry) => sum + entry.served, 0),
    [status?.stats.servedByTier],
  );

  const spend = status?.stats.spend;
  const conversation = status?.conversation;
  // The ceiling is opt-in per model, so it is keyed by the model actually serving.
  const hermesModel = status?.model ?? DEFAULT_HERMES_BRAIN_MODEL;
  const ceilings = board.hermesContextCeilings ?? {};
  const modelCeiling = ceilings[hermesModel] ?? null;

  const resetConversation = useCallback(() => {
    setBusy(true);
    resetHermesBrainConversation()
      .then(() => load())
      .catch((cause: Error) => fail("Could not reset the conversation", cause))
      .finally(() => setBusy(false));
  }, [fail, load]);

  // The server migrates an unpicked board to a real instance id, so the trigger
  // names whatever it is running on rather than whichever instance sorts first.
  const activeInstanceId = ProviderInstanceId.make(
    status?.instanceId ?? picker.instances[0]?.instanceId ?? "cursor",
  );

  const chosen = tiers.find((tier) => tier.tier === provider) ?? null;
  const providerDown = chosen !== null && !chosen.available;
  const transportLine =
    status?.providerError ??
    (chosen === null
      ? "No provider picked yet."
      : `${HERMES_TIER_LABELS[chosen.tier]} · ${chosen.model} — ${tierDetail(chosen)}`);

  if (error && !status) {
    return settingsPageShell(
      embedded,
      <SettingsSection title="Hermes" icon={<BotIcon className="size-3.5" />}>
        <SettingsRow title="Unavailable" description={error} />
      </SettingsSection>,
    );
  }

  // The board cache is the same server-authoritative value, already in memory
  // from the config stream — so a cold mount never renders a guessed "off".
  const enabled = pendingEnabled ?? status?.enabled ?? board.hermesBrainEnabled;
  const model = board.hermesBrainModel || status?.model || DEFAULT_HERMES_BRAIN_MODEL;

  return settingsPageShell(
    embedded,
    <>
      <SettingsSection id="hermes.core" title="Board brain" icon={<BotIcon className="size-3.5" />}>
        <LoopState nowMs={nowMs} onRunTick={() => runTick("real")} running={busy} />
        <SettingsRow
          title="Enable Hermes"
          description="One loop owns the board: structures drafts, launches agents, reads their reports, nudges what stopped short, and drives PR → merge. On by default, with the whole pipeline below. Switching it back on after every pipeline step was turned off restores them too."
          status={enableStatusLine(status, pendingEnabled, nowMs)}
          control={<Switch checked={enabled} disabled={busy} onCheckedChange={setEnabled} />}
        />
        <SettingsRow
          id="hermes.preflight"
          title="Box checks"
          description="Hermes runs the critical box checks before its first tick and before every beat that would cost money — disk, writable store, an agent CLI, an authenticated forge CLI, a git identity. While one of them is failing the loop keeps recovering the board but asks no model, because a card launched onto a box like that runs to completion and then cannot open its pull request."
          status={preflightStatusLine(status?.preflight, nowMs)}
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={fixingBox || environmentId === null}
              onClick={fixBox}
            >
              <HeartPulseIcon className="size-3.5" />
              {fixingBox ? "Checking…" : "Run checks & fix"}
            </Button>
          }
        />
        <SettingsRow
          id="hermes.model"
          title="Board brain model"
          description="Which model Hermes itself runs on, picked the same way as every other model in the app. Hermes drives it over that provider's own transport — cursor-agent or the grok CLI over ACP, the Codex app-server, OpenRouter over HTTPS — and there is no fallback: if it cannot serve, the tick fails and says so. A model no transport can run is greyed out here."
          status={
            <span className={providerDown || status?.providerError ? "text-amber-600" : undefined}>
              {transportLine}
            </span>
          }
          resetAction={
            status && status.model !== DEFAULT_HERMES_BRAIN_MODEL ? (
              <SettingResetButton
                label="Hermes model"
                onClick={() => patch({ instanceId: "cursor", model: DEFAULT_HERMES_BRAIN_MODEL })}
              />
            ) : undefined
          }
          control={
            <ProviderModelPicker
              lockedProvider={null}
              instanceEntries={picker.instances}
              modelOptionsByInstance={modelOptionsByInstance}
              getModelDisabledReason={getModelDisabledReason}
              triggerVariant="outline"
              triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
              disabled={busy || !status}
              activeInstanceId={activeInstanceId}
              model={model}
              onInstanceModelChange={(instanceId, nextModel) =>
                patch({ instanceId: String(instanceId), model: nextModel })
              }
            />
          }
        />
        <SettingsRow
          title="Tick interval"
          description="Heartbeat gap between ticks. A card sent, moved or edited wakes the loop straight away — this is the beat for everything else. Minimum 10s; a tick never overlaps the previous one."
          control={
            <div className="flex flex-wrap items-center gap-2">
              {INTERVAL_CHOICES.map((seconds) => (
                <Button
                  key={seconds}
                  size="xs"
                  variant={
                    Math.round((status?.intervalMs ?? 0) / 1000) === seconds ? "default" : "outline"
                  }
                  disabled={busy || !status}
                  onClick={() => patch({ intervalMs: seconds * 1000 })}
                >
                  {seconds < 60 ? `${seconds}s` : `${seconds / 60}m`}
                </Button>
              ))}
            </div>
          }
        />
        <SettingsRow
          title="Nudge escalation point"
          description="Not a cap — Hermes nudges as long as progress needs it. Past this count it is told to prefer a different decision over repeating the same nudge."
          control={
            <NumberInput
              label="Nudge escalation point"
              value={status?.maxNudges ?? 3}
              min={0}
              step={1}
              suffix="nudges"
              onCommit={(next) => patch({ maxNudges: next })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Pipeline" icon={<ActivityIcon className="size-3.5" />}>
        <p className="px-4 pt-3.5 text-sm leading-relaxed text-muted-foreground sm:px-5">
          What Hermes is allowed to do with a card each tick. All on by default — turning one off
          parks every card at that step, and the board badge says so instead of looking busy.
        </p>
        <SettingsRow
          title="Structure Prompts"
          description="Rewrite raw composer text into an agent-ready brief (Mission / Work to do / Constraints / Done when) and set project and model."
          control={
            <Switch
              checked={pipeline.structureDrafts}
              onCheckedChange={(checked) =>
                patchBoard(hermesPipelinePatch(board, "structureDrafts", Boolean(checked)))
              }
            />
          }
        />
        <SettingsRow
          title="Prompts → Active"
          description="Launch a coding thread for a ready Prompt. Needs a project on the card."
          control={
            <Switch
              checked={pipeline.launchPrompts}
              onCheckedChange={(checked) =>
                patchBoard(hermesPipelinePatch(board, "launchPrompts", Boolean(checked)))
              }
            />
          }
        />
        <SettingsRow
          title="Active → PR"
          description="When a coding thread goes quiet, ask it whether the card's goal is finished. An answer that still lists work sends it back; a clean one opens the pull request."
          control={
            <Switch
              checked={pipeline.finishActive}
              onCheckedChange={(checked) =>
                patchBoard(hermesPipelinePatch(board, "finishActive", Boolean(checked)))
              }
            />
          }
        />
        {pipeline.finishActive ? (
          <SettingsRow
            title="Completion checks per card"
            description="Ceiling on that question, not a schedule — a thread that says it is done is never asked twice. It only stops the thread that keeps finding one more thing; past it the card says it needs a decision."
            control={
              <NumberInput
                label="Completion checks per card"
                value={board.hermesCompletionMaxChecks}
                min={1}
                step={1}
                suffix="checks"
                onCommit={(next) => patchBoard({ hermesCompletionMaxChecks: next })}
              />
            }
          />
        ) : null}
        <SettingsRow
          title="Review pass before the PR"
          description="One extra review turn in the coding thread after it says it is done. Off by default — it is a second full agent turn per card."
          control={
            <Switch
              checked={board.hermesReviewPassEnabled}
              onCheckedChange={(checked) =>
                patchBoard({ hermesReviewPassEnabled: Boolean(checked) })
              }
            />
          }
        />
        {board.hermesReviewPassEnabled ? (
          <SettingsRow
            title="Review turn"
            description="What that turn asks for. Point it at a harness command or an installed skill."
            control={
              <Textarea
                className="min-h-24 w-full text-xs sm:w-96"
                defaultValue={board.hermesReviewPrompt}
                onBlur={(event) => patchBoard({ hermesReviewPrompt: event.target.value })}
              />
            }
          />
        ) : null}
        <SettingsRow
          title="Merge when green"
          description="Merge a card's pull request once the forge's checks pass. Off leaves green PRs in the PR column."
          control={
            <Switch
              checked={pipeline.mergeWhenGreen}
              onCheckedChange={(checked) =>
                patchBoard(hermesPipelinePatch(board, "mergeWhenGreen", Boolean(checked)))
              }
            />
          }
        />
        {pipeline.mergeWhenGreen ? (
          <SettingsRow
            title="PR check grace"
            description="How long after a push before absent forge checks count as a verdict. GitHub often registers runs slowly — too short reads a pending PR as check-free."
            control={
              <NumberInput
                label="PR check grace"
                value={Math.round(board.hermesPrCheckGraceMs / 60_000)}
                min={0}
                step={1}
                suffix="minutes"
                onCommit={(next) =>
                  patchBoard({ hermesPrCheckGraceMs: Math.max(0, next) * 60_000 })
                }
              />
            }
          />
        ) : null}
        <SettingsRow
          title="Watch issues"
          description="File a Prompts card for each open forge issue no card owns yet, on the orphan sweep's cadence. The column rules take it from there."
          control={
            <Switch
              checked={board.hermesWatchIssues}
              onCheckedChange={(checked) => patchBoard({ hermesWatchIssues: Boolean(checked) })}
            />
          }
        />
        {board.hermesWatchIssues ? (
          <SettingsRow
            title="Issue label filter"
            description="Only watch issues wearing this forge label. Empty watches every open issue."
            control={
              <Input
                className="w-full sm:w-64"
                placeholder="hermes"
                defaultValue={board.hermesWatchIssuesLabel}
                onBlur={(event) => patchBoard({ hermesWatchIssuesLabel: event.target.value })}
              />
            }
          />
        ) : null}
        <SettingsRow
          title="Helper threads"
          description="Ephemeral no-card threads the brain spawns to answer one question. Off means Hermes never delegates."
          control={
            <Switch
              checked={board.hermesHelpersEnabled}
              onCheckedChange={(checked) => patchBoard({ hermesHelpersEnabled: Boolean(checked) })}
            />
          }
        />
        {board.hermesHelpersEnabled ? (
          <>
            <SettingsRow
              title="Helpers running at once"
              description="Concurrency cap across the board. 0 parks helper delegation without turning the switch off."
              control={
                <NumberInput
                  label="Helpers running at once"
                  value={board.hermesHelperMaxConcurrent}
                  min={0}
                  step={1}
                  suffix="helpers"
                  onCommit={(next) => patchBoard({ hermesHelperMaxConcurrent: Math.max(0, next) })}
                />
              }
            />
            <SettingsRow
              title="Helper timeout"
              description="A helper that has not answered in this long is abandoned. Min 1 minute."
              control={
                <NumberInput
                  label="Helper timeout"
                  value={Math.round(board.hermesHelperTimeoutMs / 60_000)}
                  min={1}
                  step={1}
                  suffix="minutes"
                  onCommit={(next) =>
                    patchBoard({ hermesHelperTimeoutMs: Math.max(1, next) * 60_000 })
                  }
                />
              }
            />
          </>
        ) : null}
        <SettingsRow
          title="Stuck prep timeout"
          description="Each tick resets Draft cards stuck in skill processing for longer than this. Min 30s."
          control={
            <NumberInput
              label="Stuck prep timeout"
              value={Math.round(board.hermesStuckPrepMs / 1000)}
              min={30}
              step={10}
              suffix="seconds"
              onCommit={(next) => patchBoard({ hermesStuckPrepMs: Math.max(30, next) * 1000 })}
            />
          }
        />
        <SettingsRow
          title="Show the chip on the board"
          description="Header status for the loop: live with a countdown, working, late, failing, or idle."
          control={
            <Switch
              checked={board.showHermesChip}
              onCheckedChange={(checked) => patchBoard({ showHermesChip: Boolean(checked) })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        id="hermes.mcp"
        title="MCP servers"
        icon={<PlugIcon className="size-3.5" />}
        headerAction={
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              patchBoard({
                hermesMcpServers: [
                  ...board.hermesMcpServers,
                  {
                    name: `server${board.hermesMcpServers.length + 1}`,
                    url: "",
                    headers: {},
                    enabled: true,
                  },
                ],
              })
            }
          >
            Add server
          </Button>
        }
      >
        <div className="border-b border-border/60 px-4 py-3 text-[11px] leading-relaxed text-muted-foreground sm:px-5">
          Streamable-HTTP MCP servers the tick program may call as{" "}
          <code>mcp.&lt;name&gt;.&lt;tool&gt;()</code>. Tools are read from the server itself. One
          that will not connect is reported in Settings → System and named as unavailable in the
          prompt — never silently skipped.
        </div>
        {board.hermesMcpServers.length === 0 ? (
          <div className="px-4 py-3.5 text-xs text-muted-foreground sm:px-5">
            No servers. The <code>mcp</code> namespace is absent from the tick surface.
          </div>
        ) : (
          board.hermesMcpServers.map((entry, index) => {
            const patchServer = (next: Partial<(typeof board.hermesMcpServers)[number]>) =>
              patchBoard({
                hermesMcpServers: board.hermesMcpServers.map((current, at) =>
                  at === index ? { ...current, ...next } : current,
                ),
              });
            return (
              <SettingsRow
                key={`mcp-${index}`}
                title={
                  <Input
                    className="w-full sm:w-40"
                    aria-label="Server name"
                    placeholder="docs"
                    defaultValue={entry.name}
                    onBlur={(event) => patchServer({ name: event.target.value })}
                  />
                }
                description={
                  <Input
                    className="mt-2 w-full"
                    aria-label="Server URL"
                    placeholder="https://mcp.example.com/mcp"
                    defaultValue={entry.url}
                    onBlur={(event) => patchServer({ url: event.target.value })}
                  />
                }
                control={
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={entry.enabled}
                      onCheckedChange={(checked) => patchServer({ enabled: Boolean(checked) })}
                    />
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        patchBoard({
                          hermesMcpServers: board.hermesMcpServers.filter((_, at) => at !== index),
                        })
                      }
                    >
                      Remove
                    </Button>
                  </div>
                }
              />
            );
          })
        )}
      </SettingsSection>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-between rounded-xl bg-raised px-4 py-3 text-left transition-colors hover:bg-muted/40 sm:px-5">
          <span>
            <span className="flex items-center gap-2 text-sm font-semibold">
              <WrenchIcon className="size-4 text-muted-foreground" />
              Advanced controls and diagnostics
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">
              Budget experiments, backend fallbacks, activity, spend, context, and tick logs.
            </span>
          </span>
          <ChevronRightIcon
            className={`size-4 shrink-0 text-muted-foreground transition-transform ${advancedOpen ? "rotate-90" : ""}`}
          />
        </CollapsibleTrigger>
        <CollapsiblePanel className="pt-7">
          <div className="space-y-7">
            <HermesBudgetPanel />

            <SettingsSection
              id="hermes.backends"
              title="Providers"
              icon={<ListIcon className="size-3.5" />}
              headerAction={
                <Button size="xs" variant="ghost" disabled={probing} onClick={recheck}>
                  <RefreshCwIcon className={probing ? "size-3 animate-spin" : "size-3"} />
                  Recheck
                </Button>
              }
            >
              <div className="border-b border-border/60 px-4 py-3 text-[11px] leading-relaxed text-muted-foreground sm:px-5">
                What each transport can serve right now. Hermes only ever asks the one picked above;
                the rest are probed so you can see what is available before switching.
              </div>
              {providerDown ? (
                <div className="border-b border-border/60 bg-amber-500/10 px-4 py-2.5 text-[11px] text-amber-700 dark:text-amber-400 sm:px-5">
                  {provider === null ? "This model" : HERMES_TIER_LABELS[provider]} cannot serve
                  right now. Ticks will fail until it is reachable, or until you pick another model.
                </div>
              ) : null}
              {tiers.map((tier) => (
                <SettingsRow
                  key={tier.tier}
                  title={
                    <span className="flex items-center gap-1.5">
                      <Dot tone={tier.available ? "ready" : "down"} />
                      {HERMES_TIER_LABELS[tier.tier]}
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-normal text-muted-foreground">
                        {tier.model}
                      </span>
                    </span>
                  }
                  description={HERMES_TIER_HINTS[tier.tier]}
                  status={
                    <span
                      className={tier.enabled && !tier.available ? "text-amber-600" : undefined}
                    >
                      {tierDetail(tier)}
                    </span>
                  }
                  control={
                    tier.enabled ? (
                      <span className="text-[11px] text-muted-foreground">In use</span>
                    ) : null
                  }
                />
              ))}
            </SettingsSection>

            <SettingsSection title="Activity" icon={<ActivityIcon className="size-3.5" />}>
              <div className="grid grid-cols-2 gap-px bg-border/60 sm:grid-cols-3">
                {[
                  { label: "Heartbeats", value: status?.stats.heartbeats ?? 0 },
                  { label: "Model calls", value: status?.stats.ticks ?? 0 },
                  { label: "Model skipped", value: status?.stats.skipped ?? 0 },
                  { label: "Failed", value: status?.stats.failed ?? 0 },
                  { label: "Board writes", value: status?.stats.writes ?? 0 },
                  { label: "Nudges", value: status?.stats.nudges ?? 0 },
                  { label: "No model needed", value: status?.stats.modelSkipped ?? 0 },
                  { label: "Writes by rule", value: status?.stats.ruleWrites ?? 0 },
                ].map((stat) => (
                  <div key={stat.label} className="bg-card px-4 py-3 sm:px-5">
                    <p className="text-lg font-semibold tabular-nums">{stat.value}</p>
                    <p className="text-[11px] text-muted-foreground">{stat.label}</p>
                  </div>
                ))}
              </div>
              <SettingsRow
                title="Spend on Hermes itself"
                description={
                  spend === undefined
                    ? "No model call has reported usage yet."
                    : spend.unmeasuredCalls > 0
                      ? `${spend.measuredCalls} of ${spend.measuredCalls + spend.unmeasuredCalls} model calls reported tokens — the ACP tiers report none, so the real total is higher.`
                      : `${spend.measuredCalls} model call${spend.measuredCalls === 1 ? "" : "s"}, ${duration(spend.modelMs)} waiting on them.`
                }
              >
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 pb-3.5 text-[11px] tabular-nums">
                  <span>
                    <span className="text-sm font-semibold">{usd(spend?.usd ?? 0)}</span>{" "}
                    <span className="text-muted-foreground">billed</span>
                  </span>
                  <span className="text-muted-foreground">
                    {tokens(spend?.inputTokens ?? 0)} in ({tokens(spend?.cachedInputTokens ?? 0)}{" "}
                    cached) · {tokens(spend?.outputTokens ?? 0)} out
                  </span>
                </div>
              </SettingsRow>
              <SettingsRow
                title="Daily spend cap"
                description="Skip model ticks once Hermes itself has billed this much in the last 24h. Rules still run — merges, requeues and stuck-prep resets continue. 0 disables the cap."
                control={
                  <NumberInput
                    label="Daily spend cap"
                    value={board.hermesDailyUsdCap}
                    min={0}
                    step={1}
                    suffix="USD/day"
                    onCommit={(next) => patchBoard({ hermesDailyUsdCap: Math.max(0, next) })}
                  />
                }
              />
              <SettingsRow
                title="Served by"
                description={
                  status
                    ? `Since ${clockTime(status.stats.since)} (${relativeTime(status.stats.since, nowMs)}). Counters survive a restart; every tick is also appended to ${status.stats.usageLogPath ?? "the usage log"}.`
                    : "Waiting for status."
                }
              >
                <div className="space-y-1.5 pb-3.5">
                  {(status?.stats.servedByTier ?? []).map((entry) => (
                    <div key={entry.tier} className="flex items-center gap-2 text-[11px]">
                      <span className="w-28 shrink-0 text-muted-foreground">
                        {HERMES_TIER_LABELS[entry.tier]}
                      </span>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{
                            width: `${servedTotal > 0 ? (entry.served / servedTotal) * 100 : 0}%`,
                          }}
                        />
                      </div>
                      <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">
                        {entry.served}
                      </span>
                    </div>
                  ))}
                </div>
              </SettingsRow>
              <SettingsRow
                title="Conversation"
                description={
                  conversation && conversation.turns > 0
                    ? `${conversation.turns} turns, ≈${tokens(conversation.estTokens)} tokens carried into each tick${
                        conversation.journalEntries > 0
                          ? `, plus ${conversation.journalEntries} recorded past calls`
                          : ""
                      }. ${
                        conversation.lastEvictionAt
                          ? `${EVICTION_REASON_LABELS[conversation.lastEvictionReason ?? "settled"]} ${relativeTime(conversation.lastEvictionAt, nowMs)}; board state is re-read, never summarized.`
                          : "Nothing dropped yet — history is cut when the board settles, not on a counter."
                      } Reset wipes the history; the next tick starts from a full snapshot.`
                    : "No conversation yet — the first real tick starts one from a full board snapshot; later ticks send only the delta."
                }
              >
                <div className="pb-3.5">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={
                      busy || status?.busy === true || !conversation || conversation.turns === 0
                    }
                    onClick={resetConversation}
                  >
                    Reset conversation
                  </Button>
                </div>
              </SettingsRow>
              <SettingsRow
                title={`Context ceiling for ${hermesModel}`}
                description={
                  modelCeiling === null
                    ? "Off. History is only cut when the board settles, and an overflow is the provider's own compaction to handle. Set a ceiling only if you want Hermes to drop turns mid-decision — a 400k–1M window rarely does."
                    : `Hermes drops history once one tick's ask passes ${tokens(modelCeiling)} tokens, even with a card still undecided. Clear the field to switch the ceiling off. Applies to ${hermesModel} only.`
                }
                control={
                  <NumberInput
                    label="Context ceiling"
                    value={modelCeiling ?? 0}
                    min={0}
                    step={10_000}
                    suffix="tokens"
                    onCommit={(next) =>
                      patchBoard({
                        hermesContextCeilings:
                          next > 0
                            ? { ...ceilings, [hermesModel]: next }
                            : Object.fromEntries(
                                Object.entries(ceilings).filter(([model]) => model !== hermesModel),
                              ),
                      })
                    }
                  />
                }
              />
            </SettingsSection>

            <SettingsSection
              id="hermes.log"
              title="Tick log"
              icon={<ScrollTextIcon className="size-3.5" />}
              headerAction={
                <div className="flex items-center gap-1">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy || status?.busy === true}
                    onClick={() => runTick("dry")}
                  >
                    <PlayIcon className="size-3" />
                    Dry run
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy || status?.busy === true || !enabled}
                    onClick={() => runTick("real")}
                  >
                    Run now
                  </Button>
                </div>
              }
            >
              {status && status.log.length > 0 ? (
                <ul className="overflow-x-auto">
                  <LogHeader />
                  {status.log.map((entry) => (
                    <LogRow key={entry.id} entry={entry} nowMs={nowMs} />
                  ))}
                </ul>
              ) : (
                <SettingsRow
                  title="No ticks yet"
                  description="Dry run reads the real board and records every intended write without executing it. Run now needs Hermes on and writes for real."
                />
              )}
              <SettingsRow
                title="Where the log lives"
                description={
                  status?.logPath
                    ? `${status.logPath} — the last 30 ticks, one JSON object per line, kept across restarts. Every tick also prints an hermes.tick line to the journal (journalctl -u t3j -g hermes.tick).`
                    : "Ticks print an hermes.tick line to the journal (journalctl -u t3j -g hermes.tick). The on-disk log is unavailable — the server could not write to its base directory."
                }
              />
            </SettingsSection>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </>,
  );
}
