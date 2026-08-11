import type { HermesBudgetPlan, HermesBudgetStatus } from "@t3tools/contracts";
import { ChevronRightIcon, CoinsIcon, GaugeIcon, RulerIcon, TrendingUpIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  applyServerHermesBudgetConfig,
  readBoardSettings,
  subscribeBoardSettings,
} from "../../lib/boardSettings";
import { cn } from "../../lib/utils";
import {
  budgetPositionLabel,
  configureHermesBudget,
  fetchHermesBudgetStatus,
  formatBudgetTokens,
  formatBudgetUsd,
  measureHermesBudget,
  planHermesBudget,
} from "../../lib/hermesBudget";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const SAMPLE_TEXT =
  "fix the sticky profile-save toast. also the mobile login button wraps under the icon. and lazy-load the settings panels on phone without touching desktop.";

function Unknown({ detail }: { detail: string }) {
  return (
    <span className="text-amber-600 dark:text-amber-400" title={detail}>
      unknown
    </span>
  );
}

type HarnessRow = HermesBudgetStatus["table"]["harnesses"][number];

function HarnessRows({ rows }: { rows: ReadonlyArray<HarnessRow> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-[11px]">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1.5 pr-3 font-medium">Model</th>
            <th className="py-1.5 pr-3 font-medium">Session floor</th>
            <th className="py-1.5 pr-3 font-medium">Cache (5m / 1h / older)</th>
            <th className="py-1.5 pr-3 font-medium">Stamina</th>
            <th className="py-1.5 pr-3 font-medium">Output</th>
            <th className="py-1.5 pr-3 font-medium">$/Mtok in→out</th>
            <th className="py-1.5 font-medium">Tier</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {rows.map((harness) => (
            <tr key={`${harness.harness}/${harness.model}`} className="border-t border-border/50">
              <td className="py-1.5 pr-3">{harness.model}</td>
              <td className="py-1.5 pr-3">
                {harness.floor.status === "measured" ? (
                  <span title={`${harness.floor.detail} · ${harness.floor.measuredAt ?? ""}`}>
                    {formatBudgetTokens(harness.floor.floorTokens)} tok
                    {harness.floor.floorCachedTokens !== null && (
                      <span className="text-muted-foreground">
                        {` (${formatBudgetTokens(harness.floor.floorCachedTokens)} cached)`}
                      </span>
                    )}
                  </span>
                ) : (
                  <Unknown detail={harness.floor.detail} />
                )}
              </td>
              <td className="py-1.5 pr-3">
                {harness.cache
                  .map((row) =>
                    row.cachedFraction === null ? "?" : `${Math.round(row.cachedFraction * 100)}%`,
                  )
                  .join(" / ")}
              </td>
              <td className="py-1.5 pr-3">
                {harness.staminaCeilingPercent === null ? (
                  <Unknown detail="too few banded turns to see where this model degrades" />
                ) : (
                  <span title="context-used % where this model's own turns start degrading">
                    {`≤${Math.round(harness.staminaCeilingPercent)}%`}
                  </span>
                )}
              </td>
              <td className="py-1.5 pr-3">
                {harness.medianOutputTokens === null ? (
                  <Unknown detail="no turn observed on this harness" />
                ) : (
                  `${formatBudgetTokens(harness.medianOutputTokens)} tok`
                )}
              </td>
              <td className="py-1.5 pr-3">
                {harness.usdPerMTokIn === null ? (
                  <Unknown detail="no catalog price for this model" />
                ) : (
                  `${harness.usdPerMTokIn}→${harness.usdPerMTokOut ?? "?"}${harness.priceSource === "subscription" ? " (list)" : ""}`
                )}
              </td>
              <td className="py-1.5">
                {harness.costTier === null ? <Unknown detail="price unknown" /> : harness.costTier}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One collapsible group per harness. Flat, this table ran to hundreds of rows
 * on a box with several providers enabled — long enough that nobody read it.
 */
function MeasuredTable({
  table,
  rosterOnly,
  onRosterOnlyChange,
  rosterKeys,
}: {
  table: HermesBudgetStatus["table"];
  rosterOnly: boolean;
  onRosterOnlyChange: (next: boolean) => void;
  rosterKeys: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState<ReadonlyArray<string>>([]);

  const groups = useMemo(() => {
    const filtered = table.harnesses.filter(
      (harness) => !rosterOnly || rosterKeys.has(`${harness.harness}::${harness.model}`),
    );
    const byHarness = new Map<string, HarnessRow[]>();
    for (const harness of filtered) {
      const bucket = byHarness.get(harness.harness);
      if (bucket) bucket.push(harness);
      else byHarness.set(harness.harness, [harness]);
    }
    return [...byHarness.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [rosterKeys, rosterOnly, table.harnesses]);

  if (table.harnesses.length === 0) {
    return (
      <SettingsRow
        title="Nothing measured yet"
        description="Measure now reads every live thread's own token snapshots. Until then every number here is unknown and routing keeps its old behaviour."
      />
    );
  }

  return (
    <>
      <SettingsRow
        title="Roster models only"
        description="Hide every model auto-routing is not allowed to spend on."
        status={`${groups.reduce((sum, [, rows]) => sum + rows.length, 0)} of ${table.harnesses.length} row(s) shown.`}
        control={<Switch checked={rosterOnly} onCheckedChange={onRosterOnlyChange} />}
      />
      {groups.length === 0 ? (
        <SettingsRow
          title="No rows match"
          description="Nothing on the roster has been measured yet. Turn the filter off to see everything."
        />
      ) : (
        <div className="px-4 pb-3 sm:px-5">
          {groups.map(([harness, rows]) => {
            const isOpen = open.includes(harness);
            return (
              <div key={harness} className="border-t border-border/50 first:border-t-0">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  className="flex w-full items-center gap-1.5 py-2 text-left text-[11px] font-medium hover:text-foreground"
                  onClick={() =>
                    setOpen((current) =>
                      current.includes(harness)
                        ? current.filter((id) => id !== harness)
                        : [...current, harness],
                    )
                  }
                >
                  <ChevronRightIcon
                    className={cn("size-3 transition-transform", isOpen && "rotate-90")}
                  />
                  <span className="font-mono">{harness}</span>
                  <span className="text-muted-foreground">
                    {rows.length} model{rows.length === 1 ? "" : "s"}
                  </span>
                </button>
                {isOpen ? <HarnessRows rows={rows} /> : null}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function PlanView({ plan }: { plan: HermesBudgetPlan }) {
  return (
    <div className="space-y-2 px-4 pb-3 text-[11px] sm:px-5">
      <p className="font-mono text-[12px]">{plan.summary}</p>
      <ul className="space-y-1.5">
        {plan.tasks.map((task) => (
          <li key={task.index} className="rounded border border-border/60 p-2">
            <p className="font-medium">
              {task.index + 1}. [{task.size}] {task.title}
            </p>
            <p className="text-muted-foreground">
              {task.placement.kind === "reuse"
                ? `reuse ${task.placement.threadId} — ${task.placement.reason}`
                : `new thread — ${task.placement.reason}`}
            </p>
            <p className="font-mono text-muted-foreground">
              {task.harness
                ? `${task.harness.instanceId}/${task.harness.model} [${task.harness.costBasis}] ${task.harness.reason}`
                : "no usable harness"}
            </p>
            <p className="font-mono">
              {task.estimate.usd === null
                ? `${formatBudgetTokens(task.estimate.chargedInputTokens)} charged tok`
                : formatBudgetUsd(task.estimate.usd)}
              <span className="ml-1 text-muted-foreground">· {task.estimate.basis.join("; ")}</span>
            </p>
          </li>
        ))}
      </ul>
      {plan.unknowns.length > 0 ? (
        <p className="text-amber-600 dark:text-amber-400">unknown: {plan.unknowns.join("; ")}</p>
      ) : null}
    </div>
  );
}

export function HermesBudgetPanel() {
  const [status, setStatusState] = useState<HermesBudgetStatus | null>(null);
  // Fold every server answer into the local board cache (local-only) so a
  // later whole-object board write can't post stale budget keys back.
  const setStatus = useCallback((next: HermesBudgetStatus | null) => {
    setStatusState(next);
    if (next) applyServerHermesBudgetConfig({ enabled: next.enabled, position: next.position });
  }, []);
  const [busy, setBusy] = useState(false);
  const [draftPosition, setDraftPosition] = useState<number | null>(null);
  const [planText, setPlanText] = useState(SAMPLE_TEXT);
  const [plan, setPlan] = useState<HermesBudgetPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [board, setBoard] = useState(() => readBoardSettings());
  const [rosterOnly, setRosterOnly] = useState(() => readBoardSettings().modelRosterEnforced);

  useEffect(() => subscribeBoardSettings(setBoard), []);

  const rosterKeys = useMemo(
    () => new Set(board.modelRoster.map((entry) => `${entry.instanceId}::${entry.model}`)),
    [board.modelRoster],
  );

  const load = useCallback(
    () =>
      fetchHermesBudgetStatus().then(
        (next) => {
          setStatus(next);
          setError(null);
        },
        (cause: Error) => setError(cause.message),
      ),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const fail = useCallback((title: string, cause: Error) => {
    toastManager.add(stackedThreadToast({ type: "error", title, description: cause.message }));
  }, []);

  const position = draftPosition ?? status?.position ?? 50;

  const commitPosition = useCallback(
    (next: number) => {
      setBusy(true);
      configureHermesBudget({ position: next })
        .then((updated) => {
          setStatus(updated);
          setDraftPosition(null);
          // A slider that cannot show its own consequence is not done.
          return planText.trim() ? planHermesBudget(planText).then(setPlan) : undefined;
        })
        .catch((cause: Error) => fail("Could not move the budget slider", cause))
        .finally(() => setBusy(false));
    },
    [fail, planText],
  );

  const runPlan = useCallback(() => {
    if (!planText.trim()) return;
    setBusy(true);
    planHermesBudget(planText)
      .then(setPlan)
      .catch((cause: Error) => fail("Dry run failed", cause))
      .finally(() => setBusy(false));
  }, [fail, planText]);

  const measure = useCallback(() => {
    setBusy(true);
    measureHermesBudget()
      .then((result) => {
        setStatus(result.status);
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "Measured",
            description: `${result.threads} thread(s) read · ${result.samples} turn samples`,
          }),
        );
      })
      .catch((cause: Error) => fail("Measure failed", cause))
      .finally(() => setBusy(false));
  }, [fail]);

  const knobs = status?.knobs ?? null;
  const unknownCount = status?.table.unknowns.length ?? 0;

  const degradation = useMemo(
    () => (status?.table.degradation ?? []).filter((band) => band.sampleCount > 0),
    [status?.table.degradation],
  );

  if (error && !status) {
    return (
      <SettingsSection title="Budget routing" icon={<CoinsIcon className="size-3.5" />}>
        <SettingsRow title="Unavailable" description={error} />
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection title="Budget routing" icon={<CoinsIcon className="size-3.5" />}>
        <SettingsRow
          title="Route on measured cost"
          description="Hermes decides how many tasks, which thread each lands in, and which harness to pay for, from measured session floors, observed cache behaviour and catalog prices. Off by default — nothing routes differently until this is on."
          status={
            status?.enabled
              ? `On · ${unknownCount} unknown number${unknownCount === 1 ? "" : "s"} in the table`
              : "Off — routing uses the old size-and-utilization heuristic."
          }
          control={
            <Switch
              checked={status?.enabled === true}
              disabled={busy || !status}
              onCheckedChange={(checked) => {
                setBusy(true);
                configureHermesBudget({ enabled: checked })
                  .then(setStatus)
                  .catch((cause: Error) => fail("Could not switch budget routing", cause))
                  .finally(() => setBusy(false));
              }}
            />
          }
        />
        <SettingsRow
          title={`Cost ↔ speed · ${budgetPositionLabel(position)} (${position})`}
          description="One dial. Left buys the cheapest thing that clears the task's bar and reuses warm threads; right splits more readily, pays a heavier session floor and prefers fast variants."
          status={knobs ? <span className="font-mono">{describeKnobs(knobs)}</span> : "Loading…"}
        >
          <div className="pb-3.5">
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={position}
              disabled={busy || !status}
              className="w-full accent-primary"
              onChange={(event) => setDraftPosition(Number(event.target.value))}
              onMouseUp={(event) => commitPosition(Number(event.currentTarget.value))}
              onTouchEnd={(event) => commitPosition(Number(event.currentTarget.value))}
              onKeyUp={(event) => commitPosition(Number(event.currentTarget.value))}
            />
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Measured table"
        icon={<RulerIcon className="size-3.5" />}
        headerAction={
          <Button size="xs" variant="outline" disabled={busy} onClick={measure}>
            Measure now
          </Button>
        }
      >
        <div className="border-b border-border/60 px-4 py-3 text-[11px] leading-relaxed text-muted-foreground sm:px-5">
          Every number comes from this box's own token snapshots or a catalog price. A floor
          measured against an older provider build is reported unknown until it is re-measured.
          {status?.tablePath ? ` Stored at ${status.tablePath}.` : ""}
        </div>
        {status ? (
          <MeasuredTable
            table={status.table}
            rosterOnly={rosterOnly && rosterKeys.size > 0}
            onRosterOnlyChange={setRosterOnly}
            rosterKeys={rosterKeys}
          />
        ) : null}
      </SettingsSection>

      <SettingsSection title="Degradation proxies" icon={<GaugeIcon className="size-3.5" />}>
        {degradation.length === 0 ? (
          <SettingsRow
            title="Not measured"
            description="Tool calls, turn duration and output size per context band come from observed turns. Nothing has reported both used and max tokens yet."
          />
        ) : (
          <div className="px-4 pb-3 text-[11px] sm:px-5">
            <table className="w-full text-left font-mono">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">Context used</th>
                  <th className="py-1.5 pr-3 font-medium">Turns</th>
                  <th className="py-1.5 pr-3 font-medium">Tool calls</th>
                  <th className="py-1.5 pr-3 font-medium">Turn time</th>
                  <th className="py-1.5 font-medium">Output</th>
                </tr>
              </thead>
              <tbody>
                {degradation.map((band) => (
                  <tr key={band.band} className="border-t border-border/50">
                    <td className="py-1.5 pr-3">{band.band}</td>
                    <td className="py-1.5 pr-3">{band.sampleCount}</td>
                    <td className="py-1.5 pr-3">
                      {band.meanToolUses === null ? "?" : band.meanToolUses.toFixed(1)}
                    </td>
                    <td className="py-1.5 pr-3">
                      {band.meanTurnMs === null ? "?" : `${Math.round(band.meanTurnMs / 1000)}s`}
                    </td>
                    <td className="py-1.5">
                      {band.meanOutputTokens === null
                        ? "?"
                        : formatBudgetTokens(band.meanOutputTokens)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="pt-2 text-muted-foreground">
              Nudges per card:{" "}
              {status?.table.nudgesPerCard === null || status?.table.nudgesPerCard === undefined
                ? "unknown"
                : status.table.nudgesPerCard.toFixed(2)}{" "}
              · failed ticks:{" "}
              {status?.table.failedTickRate === null || status?.table.failedTickRate === undefined
                ? "unknown"
                : `${Math.round(status.table.failedTickRate * 100)}%`}
            </p>
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="Dry run"
        icon={<TrendingUpIcon className="size-3.5" />}
        headerAction={
          <Button size="xs" variant="outline" disabled={busy} onClick={runPlan}>
            Plan it
          </Button>
        }
      >
        <div className="px-4 py-3 sm:px-5">
          <textarea
            className="h-20 w-full rounded-md bg-raised p-2 text-xs outline-none focus:border-ring"
            value={planText}
            spellCheck={false}
            onChange={(event) => setPlanText(event.target.value)}
          />
          <p className="pt-1 text-[11px] text-muted-foreground">
            Prints split, placement, harness and estimate. Writes nothing — no card, no thread, no
            board change.
          </p>
        </div>
        {plan ? <PlanView plan={plan} /> : null}
      </SettingsSection>

      <SettingsSection title="Estimate vs actual" icon={<TrendingUpIcon className="size-3.5" />}>
        <SettingsRow
          title="Drift"
          description="Recorded per tick while budget routing is on. A router that never learns it was wrong stays wrong."
          status={
            status && status.drift.sampleCount > 0
              ? `${status.drift.sampleCount} sample(s) · mean absolute drift ${status.drift.meanAbsDriftPercent ?? "?"}%`
              : "No ticks have both predicted and billed yet."
          }
        />
        {status && status.drift.recent.length > 0 ? (
          <div className="px-4 pb-3 text-[11px] sm:px-5">
            <ul className="space-y-1 font-mono">
              {status.drift.recent.map((sample) => (
                <li key={sample.at} className="flex flex-wrap gap-2">
                  <span className="text-muted-foreground">{sample.at.slice(11, 19)}</span>
                  <span>
                    est {formatBudgetTokens(sample.estimatedInputTokens)} → actual{" "}
                    {formatBudgetTokens(sample.actualInputTokens)}
                  </span>
                  <span
                    className={
                      sample.driftPercent !== null && Math.abs(sample.driftPercent) > 50
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-muted-foreground"
                    }
                  >
                    {sample.driftPercent === null ? "drift ?" : `${sample.driftPercent}%`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </SettingsSection>
    </>
  );
}

function describeKnobs(knobs: HermesBudgetStatus["knobs"]): string {
  return [
    `tier≤${knobs.maxCostTier}`,
    knobs.preferFastVariant ? "fast variant" : "standard variant",
    `split=${knobs.splitEagerness.toFixed(2)}`,
    `batch≥${Math.round(knobs.clusterOverlapFloor * 100)}%`,
    `reuse<${knobs.reuseContextCeilingPercent}%`,
    `fresh≥${knobs.hardFreshCeilingPercent}%`,
    knobs.payHeavySessionFloor ? "heavy floor ok" : "avoid heavy floor",
  ].join(" · ");
}
