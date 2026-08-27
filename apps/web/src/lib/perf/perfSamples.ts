/**
 * What a performance recording is made of, and what it says.
 *
 * Pure: no browser, no React. {@link perfRecorder} fills a {@link PerfSession}
 * from the live page, this turns one into ranked {@link PerfFinding}s and the
 * markdown you hand somebody — "this is what is slow, fix it" — and the tests
 * run it as data.
 *
 * @module lib/perf/perfSamples
 */

export const PERF_SAMPLE_KINDS = [
  "mount",
  "unmount",
  "longtask",
  "frame-gap",
  "interaction",
] as const;
export type PerfSampleKind = (typeof PERF_SAMPLE_KINDS)[number];

export interface PerfSample {
  readonly kind: PerfSampleKind;
  /** Milliseconds since the recording started. */
  readonly at: number;
  /** A panel address (`thread:t_abc`), an event name, or "" for frame gaps. */
  readonly target: string;
  /** How long it took: mount work, task length, gap length. */
  readonly ms: number;
  /** Mounts only — how many times this target had been built before. 0 is the first. */
  readonly repeat?: number;
}

export interface PerfSession {
  readonly startedAt: string;
  readonly durationMs: number;
  /** Frames the rAF sampler saw, so the gaps have a denominator. */
  readonly frames: number;
  readonly agent: string;
  readonly cores: number;
  /** Anything the recorder could not measure here — never silently dropped. */
  readonly notes: ReadonlyArray<string>;
  readonly samples: ReadonlyArray<PerfSample>;
}

/** The browser's own definition of a long task. */
export const LONG_TASK_MS = 50;
/** Three frames at 60Hz — past this the canvas is visibly stuttering. */
export const FRAME_GAP_MS = 50;
/** A single build this expensive is felt whether or not it repeats. */
export const SLOW_MOUNT_MS = 100;
/** Past this an interaction reads as the app having ignored the click. */
export const SLOW_INTERACTION_MS = 200;

export type PerfSeverity = "high" | "medium" | "low";

export interface PerfFinding {
  readonly id: string;
  readonly severity: PerfSeverity;
  readonly title: string;
  /** The numbers behind the title. */
  readonly detail: string;
  /** What to change. Empty when the samples do not say. */
  readonly hint: string;
  /** Milliseconds this cost, and the ranking key. */
  readonly costMs: number;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function formatMs(value: number): string {
  return value >= 1_000 ? `${round(value / 1_000)} s` : `${Math.round(value)} ms`;
}

function severityFor(costMs: number, high: number, medium: number): PerfSeverity {
  if (costMs >= high) return "high";
  if (costMs >= medium) return "medium";
  return "low";
}

interface TargetMounts {
  readonly target: string;
  readonly mounts: number;
  readonly rebuilds: number;
  readonly rebuildMs: number;
  readonly worstMs: number;
}

function mountsByTarget(samples: ReadonlyArray<PerfSample>): ReadonlyArray<TargetMounts> {
  const byTarget = new Map<
    string,
    { mounts: number; rebuilds: number; rebuildMs: number; worstMs: number }
  >();
  for (const sample of samples) {
    if (sample.kind !== "mount") continue;
    const entry = byTarget.get(sample.target) ?? {
      mounts: 0,
      rebuilds: 0,
      rebuildMs: 0,
      worstMs: 0,
    };
    entry.mounts += 1;
    if ((sample.repeat ?? 0) > 0) {
      entry.rebuilds += 1;
      entry.rebuildMs += sample.ms;
    }
    entry.worstMs = Math.max(entry.worstMs, sample.ms);
    byTarget.set(sample.target, entry);
  }
  return [...byTarget.entries()]
    .map(([target, entry]) => ({ target, ...entry }))
    .toSorted((a, b) => b.rebuildMs - a.rebuildMs || b.rebuilds - a.rebuilds);
}

function churnFindings(samples: ReadonlyArray<PerfSample>): ReadonlyArray<PerfFinding> {
  return mountsByTarget(samples)
    .filter((entry) => entry.rebuilds > 0)
    .map((entry) => ({
      id: `churn:${entry.target}`,
      severity: severityFor(entry.rebuildMs, 250, 50),
      title: `${entry.target} was torn down and rebuilt ${entry.rebuilds}×`,
      detail: `${formatMs(entry.rebuildMs)} of rebuild work across ${entry.mounts} mounts, worst single build ${formatMs(entry.worstMs)}.`,
      hint: "Keep it mounted — same slot in the element tree, hidden rather than unmounted — instead of swapping what renders there.",
      costMs: entry.rebuildMs,
    }));
}

function slowMountFindings(samples: ReadonlyArray<PerfSample>): ReadonlyArray<PerfFinding> {
  return mountsByTarget(samples)
    .filter((entry) => entry.rebuilds === 0 && entry.worstMs >= SLOW_MOUNT_MS)
    .map((entry) => ({
      id: `slow-mount:${entry.target}`,
      severity: severityFor(entry.worstMs, 400, 200),
      title: `${entry.target} takes ${formatMs(entry.worstMs)} to build`,
      detail: `Built ${entry.mounts}× and never rebuilt, so this is first-open cost, not churn.`,
      hint: "Split the first paint from the work behind it, or build it before it is looked at.",
      costMs: entry.worstMs,
    }));
}

function longTaskFinding(samples: ReadonlyArray<PerfSample>): PerfFinding | null {
  const tasks = samples.filter((sample) => sample.kind === "longtask");
  if (tasks.length === 0) return null;
  const blocking = tasks.reduce((total, task) => total + Math.max(0, task.ms - LONG_TASK_MS), 0);
  const worst = tasks.reduce((max, task) => Math.max(max, task.ms), 0);
  return {
    id: "longtasks",
    severity: severityFor(blocking, 600, 150),
    title: `${tasks.length} long tasks blocked the main thread`,
    detail: `${formatMs(blocking)} of blocking time, worst task ${formatMs(worst)}.`,
    hint: "Long tasks eat the pointer and the camera. Find what runs in them — the mounts and interactions below overlap them by timestamp.",
    costMs: blocking,
  };
}

function frameFinding(session: PerfSession): PerfFinding | null {
  const gaps = session.samples.filter((sample) => sample.kind === "frame-gap");
  if (gaps.length === 0) return null;
  const lost = gaps.reduce((total, gap) => total + gap.ms, 0);
  const worst = gaps.reduce((max, gap) => Math.max(max, gap.ms), 0);
  const fps = session.durationMs > 0 ? round((session.frames * 1_000) / session.durationMs) : 0;
  return {
    id: "frames",
    severity: severityFor(lost, 1_500, 400),
    title: `${gaps.length} stutters — ${fps} fps average`,
    detail: `${formatMs(lost)} spent in frames longer than ${FRAME_GAP_MS} ms, worst ${formatMs(worst)}.`,
    hint: "",
    costMs: lost,
  };
}

function interactionFindings(samples: ReadonlyArray<PerfSample>): ReadonlyArray<PerfFinding> {
  const byName = new Map<string, { count: number; worstMs: number; totalMs: number }>();
  for (const sample of samples) {
    if (sample.kind !== "interaction" || sample.ms < SLOW_INTERACTION_MS) continue;
    const entry = byName.get(sample.target) ?? { count: 0, worstMs: 0, totalMs: 0 };
    entry.count += 1;
    entry.totalMs += sample.ms;
    entry.worstMs = Math.max(entry.worstMs, sample.ms);
    byName.set(sample.target, entry);
  }
  return [...byName.entries()]
    .map(([name, entry]) => ({
      id: `interaction:${name}`,
      severity: severityFor(entry.worstMs, 500, SLOW_INTERACTION_MS),
      title: `${name} took ${formatMs(entry.worstMs)} to respond`,
      detail: `${entry.count} slow ${name} events, ${formatMs(entry.totalMs)} total.`,
      hint: "",
      costMs: entry.totalMs,
    }))
    .toSorted((a, b) => b.costMs - a.costMs);
}

/** Everything the samples say went wrong, worst first. */
export function analyzePerfSession(session: PerfSession): ReadonlyArray<PerfFinding> {
  const findings = [
    ...churnFindings(session.samples),
    ...slowMountFindings(session.samples),
    ...interactionFindings(session.samples),
    longTaskFinding(session.samples),
    frameFinding(session),
  ].filter((finding): finding is PerfFinding => finding !== null);
  return findings.toSorted((a, b) => b.costMs - a.costMs);
}

const SEVERITY_MARK: Record<PerfSeverity, string> = {
  high: "🔴 high",
  medium: "🟠 medium",
  low: "🟡 low",
};

/** How many raw samples the report carries under the findings. */
export const REPORT_SAMPLE_LIMIT = 40;

/** The recording as markdown — the thing you paste at an agent. */
export function renderPerfReport(session: PerfSession): string {
  const findings = analyzePerfSession(session);
  const lines: Array<string> = [];
  lines.push("# Performance report");
  lines.push("");
  lines.push(
    `${formatMs(session.durationMs)} recorded at ${session.startedAt} · ${session.cores} cores · ${session.agent}`,
  );
  lines.push("");
  lines.push("## Findings");
  lines.push("");
  if (findings.length === 0) {
    lines.push("Nothing over threshold in this recording.");
  } else {
    for (const [index, finding] of findings.entries()) {
      lines.push(`${index + 1}. **${SEVERITY_MARK[finding.severity]}** — ${finding.title}`);
      lines.push(`   ${finding.detail}`);
      if (finding.hint.length > 0) lines.push(`   → ${finding.hint}`);
    }
  }
  lines.push("");
  lines.push("## Counters");
  lines.push("");
  lines.push(`- frames: ${session.frames}`);
  for (const kind of PERF_SAMPLE_KINDS) {
    const count = session.samples.filter((sample) => sample.kind === kind).length;
    if (count > 0) lines.push(`- ${kind}: ${count}`);
  }
  for (const note of session.notes) lines.push(`- note: ${note}`);
  lines.push("");
  lines.push(`## Slowest samples`);
  lines.push("");
  lines.push("| t+ | kind | target | ms |");
  lines.push("| --- | --- | --- | --- |");
  const worst = session.samples.toSorted((a, b) => b.ms - a.ms).slice(0, REPORT_SAMPLE_LIMIT);
  for (const sample of worst) {
    lines.push(
      `| ${round(sample.at / 1_000)}s | ${sample.kind} | ${sample.target === "" ? "—" : sample.target} | ${Math.round(sample.ms)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
