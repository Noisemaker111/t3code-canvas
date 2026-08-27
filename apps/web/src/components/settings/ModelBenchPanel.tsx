import { FlaskConicalIcon, Loader2Icon, PlayIcon, Trash2Icon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import {
  appendBenchHistory,
  clearBenchHistory,
  computeMetricPodium,
  fetchOpenRouterCatalog,
  formatMs,
  formatUsd,
  formatUsdExact,
  groupCompareRows,
  pickSemiCheapModelSlugs,
  primaryTrial,
  readBenchHistory,
  runServerModelBenchProgressive,
  type BenchHighlightField,
  type BenchProgressSlot,
  type ModelBenchCandidate,
  type ModelBenchFixtureMode,
  type ModelBenchRole,
  type ModelBenchTrialResult,
} from "../../lib/modelBench";
import { formatRoutedModelLabel } from "../../lib/modelLabels";
import { updateBoardSettings } from "../../lib/boardSettings";
import type { AppModelOption } from "../../modelSelection";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

const MAX_PICK_STRUCTURE = 12;
const MAX_PICK_HERMES = 6;

function newRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

const METRIC_HEADERS = ["TTFT", "Done", "In", "Out", "$", "Fmt", "Intel"] as const;
const METRIC_FIELDS = ["ttft", "done", "in", "out", "cost", "fmt", "intel"] as const;

type MetricField = (typeof METRIC_FIELDS)[number];

function cellOf(
  t: ModelBenchTrialResult | null,
  field: MetricField,
): { text: string; title?: string } {
  if (!t) return { text: "—" };
  if (!t.ok) return { text: field === "fmt" || field === "intel" ? "fail" : "—" };
  switch (field) {
    case "ttft":
      return {
        text: formatMs(t.ttftMs),
        title:
          t.headersMs != null
            ? `First token after stream open · queue/headers ${formatMs(t.headersMs)}`
            : "First token after stream open",
      };
    case "done":
      return {
        text: formatMs(t.completionMs),
        title: "Request start → stream end",
      };
    case "in":
      return { text: String(t.promptTokens) };
    case "out":
      return { text: String(t.completionTokens) };
    case "cost":
      return {
        text: formatUsd(t.costUsd),
        title:
          t.costUsd == null
            ? "Cost unknown"
            : `${formatUsdExact(t.costUsd)} · ${t.costSource} · ${t.tokensSource}`,
      };
    case "fmt":
      return {
        text: String(t.structureScore ?? t.qualityScore ?? 0),
        title:
          t.role === "structure"
            ? "Mission shape + kept ramble detail"
            : "Structure / format heuristic",
      };
    case "intel": {
      const score = t.intelligenceScore;
      if (score === null || score === undefined) {
        return { text: "—", title: "Judge unavailable" };
      }
      const dims = t.intelligence;
      const dimTitle = dims
        ? `F${dims.fidelity} R${dims.reasoning} A${dims.actionability} C${dims.completeness}${t.intelligenceNote ? ` — ${t.intelligenceNote}` : ""}`
        : (t.intelligenceNote ?? "LLM judge");
      return { text: String(score), title: dimTitle };
    }
    default:
      return { text: "—" };
  }
}

function podiumClass(place: 1 | 2 | undefined): string {
  if (place === 1) return "bg-emerald-500/15 font-semibold text-emerald-800 dark:text-emerald-200";
  if (place === 2) return "bg-amber-500/12 font-medium text-amber-900 dark:text-amber-100";
  return "";
}

function RankBadge({ place }: { place: number }) {
  if (place === 1) {
    return (
      <span
        className="inline-flex size-5 items-center justify-center rounded-full bg-emerald-500/20 text-[10px] font-bold text-emerald-700 dark:text-emerald-300"
        title="Best overall rank"
      >
        1
      </span>
    );
  }
  if (place === 2) {
    return (
      <span
        className="inline-flex size-5 items-center justify-center rounded-full bg-amber-500/20 text-[10px] font-bold text-amber-800 dark:text-amber-200"
        title="2nd overall rank"
      >
        2
      </span>
    );
  }
  return (
    <span className="inline-flex size-5 items-center justify-center text-[10px] tabular-nums text-muted-foreground">
      {place}
    </span>
  );
}

function StatusPill({ status }: { status: BenchProgressSlot["status"] }) {
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[9px] font-medium text-sky-700 dark:text-sky-300">
        <Loader2Icon className="size-2.5 animate-spin" />
        running
      </span>
    );
  }
  if (status === "queued") {
    return (
      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
        queued
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="rounded-full bg-destructive/15 px-1.5 py-0.5 text-[9px] font-medium text-destructive">
        error
      </span>
    );
  }
  return (
    <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700 dark:text-emerald-300">
      done
    </span>
  );
}

export function ModelBenchPanel(props: {
  readonly instanceId: string;
  readonly modelOptions: ReadonlyArray<AppModelOption>;
  readonly onApplied?: () => void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [filter, setFilter] = useState("");
  const [fixtureMode, setFixtureMode] = useState<ModelBenchFixtureMode>("structure");
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<ReadonlyArray<ModelBenchTrialResult>>(() =>
    readBenchHistory(),
  );
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [slots, setSlots] = useState<ReadonlyArray<BenchProgressSlot>>([]);
  const abortRef = useRef<AbortController | null>(null);

  const maxPick = fixtureMode === "structure" ? MAX_PICK_STRUCTURE : MAX_PICK_HERMES;

  const filteredOptions = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return props.modelOptions.filter((option) => {
      if (!q) return true;
      return formatRoutedModelLabel(option).toLowerCase().includes(q);
    });
  }, [filter, props.modelOptions]);

  const compareRows = useMemo(() => {
    const rows = groupCompareRows(history, activeRunId ?? undefined);
    if (rows.length > 0) return rows;
    const latestRun = history[history.length - 1]?.runId;
    return latestRun ? groupCompareRows(history, latestRun) : groupCompareRows(history);
  }, [activeRunId, history]);

  const isStructureView = useMemo(() => {
    if (running && fixtureMode === "structure") return true;
    if (compareRows.some((r) => r.structure != null)) {
      return !compareRows.some((r) => r.hermes);
    }
    return fixtureMode === "structure";
  }, [compareRows, fixtureMode, running]);

  const podiums = useMemo(() => {
    const fields: BenchHighlightField[] = ["ttft", "done", "cost", "fmt", "intel"];
    const map = new Map<BenchHighlightField, ReadonlyMap<string, 1 | 2>>();
    for (const f of fields) {
      map.set(f, computeMetricPodium(compareRows, f));
    }
    return map;
  }, [compareRows]);

  const progress = useMemo(() => {
    if (slots.length === 0) return null;
    const done = slots.filter((s) => s.status === "done" || s.status === "error").length;
    return { done, total: slots.length };
  }, [slots]);

  const toggle = (slug: string) => {
    if (running) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else {
        if (next.size >= maxPick) {
          toastManager.add({
            type: "error",
            title: `At most ${maxPick} models`,
            description: "Deselect some first.",
          });
          return prev;
        }
        next.add(slug);
      }
      return next;
    });
  };

  const loadSemiCheapPreset = useCallback(async () => {
    if (running) return;
    const catalog = await fetchOpenRouterCatalog();
    const slugs = pickSemiCheapModelSlugs({
      optionSlugs: props.modelOptions.map((o) => o.slug),
      catalogEntries: catalog.entries,
      max: maxPick,
    });
    if (slugs.length === 0) {
      toastManager.add({
        type: "error",
        title: "No semi-cheap models found",
        description: catalog.error ?? "Need paid OpenRouter models on this instance.",
      });
      return;
    }
    setSelected(new Set(slugs));
    setFilter("");
    toastManager.add({
      type: "success",
      title: `Preset · ${slugs.length} models`,
      description: "Paid versioned OpenRouter ids (no free / no Gemini 2.x).",
    });
  }, [maxPick, props.modelOptions, running]);

  const runBench = useCallback(async () => {
    if (selected.size === 0) {
      toastManager.add({
        type: "error",
        title: "Pick models first",
        description: "Use Semi-cheap preset or tick models.",
      });
      return;
    }

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    const runId = newRunId();
    setActiveRunId(runId);
    setRunning(true);

    const candidates: ModelBenchCandidate[] = [...selected].map((model) => {
      const option = props.modelOptions.find((o) => o.slug === model);
      return {
        instanceId: props.instanceId,
        model,
        label: option ? formatRoutedModelLabel(option) : model,
      };
    });

    setSlots(
      candidates.map((c) => ({
        key: `${c.instanceId}:${c.model}`,
        instanceId: c.instanceId,
        model: c.model,
        label: c.label,
        status: "queued" as const,
      })),
    );

    const roles: ModelBenchRole[] = fixtureMode === "structure" ? ["structure"] : ["hermes"];

    const { errors } = await runServerModelBenchProgressive({
      candidates,
      roles,
      concurrency: 2,
      signal: ac.signal,
      onSlot: (slot) => {
        setSlots((prev) => {
          const next = prev.map((s) => (s.key === slot.key ? { ...s, ...slot } : s));
          return next;
        });
      },
      onTrial: (trials) => {
        const stamped = trials.map((t) => ({ ...t, runId }));
        appendBenchHistory(stamped);
        // Progressive insert: re-read so table re-ranks as rows arrive.
        setHistory([...readBenchHistory()]);
      },
    });

    if (!ac.signal.aborted) {
      setRunning(false);
      toastManager.add({
        type: errors > 0 ? "error" : "success",
        title: errors > 0 ? `Bench done · ${errors} failed` : "Bench complete",
        description: "Rows filled as each model finished. Sort is live by rank.",
      });
    }
  }, [fixtureMode, props.instanceId, props.modelOptions, selected]);

  const applyRole = (trial: ModelBenchTrialResult) => {
    updateBoardSettings({
      hermesInstanceId: trial.instanceId,
      hermesModel: trial.model,
    });
    toastManager.add({
      type: "success",
      title: "Skills model set",
      description: `${trial.label} — browser skill runs, not the board brain (that lives in Settings → Hermes).`,
    });
    props.onApplied?.();
  };

  const placeOf = (field: BenchHighlightField, key: string): 1 | 2 | undefined =>
    podiums.get(field)?.get(key);

  /** Merge finished compare rows with in-flight slots so the table grows live. */
  const tableRows = useMemo(() => {
    const byKey = new Map<string, (typeof compareRows)[number]>(
      compareRows.map((r) => [`${r.instanceId}:${r.model}`, r]),
    );
    const ordered: Array<{
      key: string;
      label: string;
      instanceId: string;
      model: string;
      row: (typeof compareRows)[number] | null;
      slot: BenchProgressSlot | null;
      rankPlace: number | null;
    }> = [];

    // Finished rows first (already ranked)
    compareRows.forEach((r, i) => {
      const key = `${r.instanceId}:${r.model}`;
      ordered.push({
        key,
        label: r.label,
        instanceId: r.instanceId,
        model: r.model,
        row: r,
        slot: slots.find((s) => s.key === key) ?? null,
        rankPlace: r.combinedRank >= 0 ? i + 1 : null,
      });
    });

    // Pending / running not yet in results
    for (const slot of slots) {
      if (byKey.has(slot.key)) continue;
      ordered.push({
        key: slot.key,
        label: slot.label,
        instanceId: slot.instanceId,
        model: slot.model,
        row: null,
        slot,
        rankPlace: null,
      });
    }
    return ordered;
  }, [compareRows, slots]);

  return (
    <div className="space-y-3 border-t border-border/60 px-4 py-3.5 sm:px-5">
      <div className="min-w-0 space-y-1">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold tracking-[-0.01em]">
          <FlaskConicalIcon className="size-3.5 text-muted-foreground" />
          Model bench
        </h3>
        <p className="text-[11px] leading-snug text-muted-foreground">
          Structure fixture = voice ramble → mission. Results{" "}
          <strong className="font-medium text-foreground/80">stream into the table</strong> as each
          model finishes. Green = best, amber = 2nd for that column.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={running}
          className={cn(
            "rounded-md border px-2.5 py-1 text-[11px] font-medium",
            fixtureMode === "structure"
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border/70 text-muted-foreground hover:bg-accent/40",
          )}
          onClick={() => setFixtureMode("structure")}
        >
          Structure (ramble)
        </button>
        <button
          type="button"
          disabled={running}
          className={cn(
            "rounded-md border px-2.5 py-1 text-[11px] font-medium",
            fixtureMode === "hermes"
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border/70 text-muted-foreground hover:bg-accent/40",
          )}
          onClick={() => setFixtureMode("hermes")}
        >
          Hermes brief
        </button>
      </div>

      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        disabled={running}
        placeholder="Filter openrouter/, gemini-3, haiku-4.5, deepseek-v4…"
        className="h-8 w-full rounded-md bg-raised px-2 text-xs outline-none focus:border-ring disabled:opacity-60"
      />

      <div className="max-h-36 space-y-0.5 overflow-y-auto rounded-md border border-border/60 p-1">
        {filteredOptions.length === 0 ? (
          <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">No models</p>
        ) : (
          filteredOptions.map((option) => {
            const label = formatRoutedModelLabel(option);
            const on = selected.has(option.slug);
            const isOr =
              option.slug.includes("openrouter") ||
              option.subProvider?.toLowerCase().includes("openrouter");
            return (
              <label
                key={option.slug}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[11px] hover:bg-accent/50",
                  on && "bg-accent/40",
                  running && "pointer-events-none opacity-70",
                )}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(option.slug)}
                  disabled={running}
                  className="size-3.5"
                />
                <span className="min-w-0 flex-1 truncate font-mono">{label}</span>
                {!isOr ? (
                  <span className="shrink-0 text-[9px] text-muted-foreground">no metrics</span>
                ) : null}
              </label>
            );
          })
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={running || selected.size === 0}
          onClick={() => void runBench()}
          className="gap-1.5"
        >
          {running ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <PlayIcon className="size-3.5" />
          )}
          {running
            ? progress
              ? `Running ${progress.done}/${progress.total}…`
              : "Starting…"
            : fixtureMode === "structure"
              ? `Bench structure · ${selected.size || 0}`
              : `Bench Hermes · ${selected.size || 0}`}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={running}
          onClick={() => void loadSemiCheapPreset()}
        >
          Semi-cheap preset
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={running}
          onClick={() => setSelected(new Set())}
        >
          Clear pick
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={running || history.length === 0}
          className="gap-1 text-muted-foreground"
          onClick={() => {
            clearBenchHistory();
            setHistory([]);
            setActiveRunId(null);
            setSlots([]);
          }}
        >
          <Trash2Icon className="size-3" />
          Clear saved
        </Button>
      </div>

      {progress && running ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span>
              Live progress · {progress.done} of {progress.total} models
            </span>
            <span className="tabular-nums">
              {Math.round((progress.done / Math.max(1, progress.total)) * 100)}%
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300"
              style={{
                width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%`,
              }}
            />
          </div>
        </div>
      ) : null}

      {tableRows.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-border/60">
          <table className="w-full min-w-[40rem] border-collapse text-left text-[11px]">
            <thead className="sticky top-0 z-[1] bg-muted/90 text-[10px] uppercase tracking-wide text-muted-foreground backdrop-blur">
              <tr>
                <th className="w-8 px-1.5 py-2 text-center font-semibold">#</th>
                <th className="min-w-[10rem] px-2 py-2 font-semibold">Model</th>
                <th className="w-16 px-1 py-2 text-center font-semibold">Status</th>
                {METRIC_HEADERS.map((h) => (
                  <th
                    key={h}
                    className="border-l border-border/40 px-1.5 py-2 text-center font-medium"
                    title={
                      h === "TTFT"
                        ? "Lower is better · green = best, amber = 2nd"
                        : h === "Done"
                          ? "Lower is better"
                          : h === "$"
                            ? "Lower is better · list price × usage"
                            : h === "Fmt" || h === "Intel"
                              ? "Higher is better"
                              : undefined
                    }
                  >
                    {h}
                  </th>
                ))}
                <th className="border-l border-border/40 px-2 py-2 text-center font-semibold">
                  Score
                </th>
                <th className="px-2 py-2 font-semibold">Apply</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((entry, index) => {
                const t = entry.row ? primaryTrial(entry.row) : null;
                const key = entry.key;
                const place = entry.rankPlace ?? index + 1;

                return (
                  <tr
                    key={key}
                    className={cn(
                      "border-t border-border/50 transition-colors",
                      entry.slot?.status === "running" && "bg-sky-500/5",
                      place === 1 && entry.row && "bg-emerald-500/[0.06]",
                      place === 2 && entry.row && "bg-amber-500/[0.04]",
                    )}
                  >
                    <td className="px-1.5 py-2 text-center align-middle">
                      {entry.row && entry.row.combinedRank >= 0 ? (
                        <RankBadge place={place} />
                      ) : (
                        <span className="text-[10px] text-muted-foreground/50">·</span>
                      )}
                    </td>
                    <td className="max-w-[14rem] px-2 py-2 align-top">
                      <div className="truncate font-mono text-[10px] font-medium leading-snug">
                        {entry.label}
                      </div>
                      {t && !t.ok ? (
                        <div className="mt-0.5 text-[9px] text-destructive">{t.error}</div>
                      ) : null}
                      {entry.slot?.error ? (
                        <div className="mt-0.5 text-[9px] text-destructive">{entry.slot.error}</div>
                      ) : null}
                      {t?.intelligenceNote ? (
                        <div className="mt-0.5 line-clamp-2 text-[9px] text-muted-foreground">
                          {t.intelligenceNote}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-1 py-2 text-center align-middle">
                      {entry.slot ? (
                        <StatusPill status={entry.slot.status} />
                      ) : entry.row ? (
                        <StatusPill status="done" />
                      ) : (
                        "—"
                      )}
                    </td>
                    {METRIC_FIELDS.map((f) => {
                      const c = cellOf(t, f);
                      const highlightField =
                        f === "ttft" || f === "done" || f === "cost" || f === "fmt" || f === "intel"
                          ? (f as BenchHighlightField)
                          : null;
                      const podium = highlightField ? placeOf(highlightField, key) : undefined;
                      return (
                        <td
                          key={f}
                          title={c.title}
                          className={cn(
                            "border-l border-border/40 px-1.5 py-2 text-center tabular-nums align-middle",
                            podiumClass(podium),
                            f === "intel" && t?.ok && !podium && "font-semibold",
                            !t && "text-muted-foreground/40",
                          )}
                        >
                          {entry.slot?.status === "running" && !t ? (
                            <Loader2Icon className="mx-auto size-3 animate-spin text-sky-500" />
                          ) : (
                            c.text
                          )}
                        </td>
                      );
                    })}
                    <td className="border-l border-border/40 px-2 py-2 text-center font-medium tabular-nums align-middle">
                      {entry.row && entry.row.combinedRank >= 0
                        ? entry.row.combinedRank.toFixed(1)
                        : "—"}
                    </td>
                    <td className="px-1.5 py-2 align-middle">
                      {t?.ok ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          className="h-6 px-1.5 text-[10px]"
                          onClick={() => applyRole(t)}
                        >
                          → Skills
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="border-t border-border/50 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
            <span className="mr-2 inline-flex items-center gap-1">
              <span className="inline-block size-2 rounded-sm bg-emerald-500/40" /> best
            </span>
            <span className="mr-3 inline-flex items-center gap-1">
              <span className="inline-block size-2 rounded-sm bg-amber-500/40" /> 2nd
            </span>
            TTFT / Done / $ → lower better · Fmt / Intel → higher better · rows appear as models
            finish · Score ranks overall · Intel judge{" "}
            <code className="text-[9px]">x-ai/grok-4.5</code>
          </p>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          No runs yet. <strong className="font-medium text-foreground/80">Semi-cheap preset</strong>{" "}
          → <strong className="font-medium text-foreground/80">Bench structure</strong>. Table fills
          model-by-model.
        </p>
      )}
    </div>
  );
}
