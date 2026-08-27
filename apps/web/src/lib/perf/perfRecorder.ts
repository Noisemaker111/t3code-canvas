/**
 * The recorder: one session at a time, off until somebody presses record.
 *
 * Off it costs a boolean check per panel mount. On it watches the four things
 * that make this app feel slow — panel bodies being torn down and rebuilt, long
 * tasks, dropped frames, and interactions the page took too long to answer — and
 * hands the lot to {@link renderPerfReport}.
 *
 * Everything the browser cannot measure here becomes a note on the session
 * rather than a quietly missing counter.
 *
 * @module lib/perf/perfRecorder
 */

import {
  FRAME_GAP_MS,
  SLOW_INTERACTION_MS,
  type PerfSample,
  type PerfSession,
} from "./perfSamples";

/** Past this the recording stops itself and says so, rather than dropping samples. */
export const MAX_PERF_SAMPLES = 4_000;

/** Coalesce the subscriber tick — a sample per frame must not be a render per frame. */
const NOTIFY_MS = 400;

interface RecorderState {
  recording: boolean;
  startedAtMs: number;
  startedAtIso: string;
  frames: number;
  lastFrameMs: number;
  rafId: number;
  samples: Array<PerfSample>;
  notes: Array<string>;
  observers: Array<PerformanceObserver>;
  /** How many times each target has been built this session. */
  builds: Map<string, number>;
  notifyTimer: ReturnType<typeof setTimeout> | null;
}

const state: RecorderState = {
  recording: false,
  startedAtMs: 0,
  startedAtIso: "",
  frames: 0,
  lastFrameMs: 0,
  rafId: 0,
  samples: [],
  notes: [],
  observers: [],
  builds: new Map(),
  notifyTimer: null,
};

const listeners = new Set<() => void>();

function notify(): void {
  if (state.notifyTimer !== null) return;
  state.notifyTimer = setTimeout(() => {
    state.notifyTimer = null;
    for (const listener of listeners) listener();
  }, NOTIFY_MS);
}

function push(sample: PerfSample): void {
  if (!state.recording) return;
  if (state.samples.length >= MAX_PERF_SAMPLES) {
    state.notes.push(`Stopped at ${MAX_PERF_SAMPLES} samples — the recording was still running.`);
    stopPerfRecording();
    return;
  }
  state.samples.push(sample);
  notify();
}

/** Milliseconds since the recording started; 0 when nothing is recording. */
export function perfNow(): number {
  return state.recording ? performance.now() - state.startedAtMs : 0;
}

export function isPerfRecording(): boolean {
  return state.recording;
}

export function subscribePerf(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * A panel body finished building. `renderedAt` is {@link perfNow} taken on its
 * first render, so the number covers the whole subtree's commit.
 */
export function recordPerfMount(target: string, renderedAt: number): void {
  if (!state.recording) return;
  const repeat = state.builds.get(target) ?? 0;
  state.builds.set(target, repeat + 1);
  // Zero means the first render happened before this recording did: the build
  // is real but its length is not ours to claim.
  const at = renderedAt > 0 ? renderedAt : perfNow();
  push({ kind: "mount", at, target, ms: perfNow() - at, repeat });
}

export function recordPerfUnmount(target: string, mountedAt: number): void {
  if (!state.recording) return;
  push({ kind: "unmount", at: perfNow(), target, ms: perfNow() - mountedAt });
}

function observe(type: string, handle: (entry: PerformanceEntry) => void, options?: object): void {
  const supported = PerformanceObserver.supportedEntryTypes.includes(type);
  if (!supported) {
    state.notes.push(
      `This browser does not report \`${type}\` — that column is missing, not zero.`,
    );
    return;
  }
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) handle(entry);
  });
  observer.observe({ type, ...options });
  state.observers.push(observer);
}

function sampleFrames(): void {
  const now = performance.now();
  const gap = now - state.lastFrameMs;
  state.frames += 1;
  if (gap >= FRAME_GAP_MS)
    push({ kind: "frame-gap", at: now - state.startedAtMs, target: "", ms: gap });
  state.lastFrameMs = now;
  state.rafId = requestAnimationFrame(sampleFrames);
}

export function startPerfRecording(): void {
  if (state.recording) return;
  state.recording = true;
  state.startedAtMs = performance.now();
  state.startedAtIso = new Date().toISOString();
  state.frames = 0;
  state.lastFrameMs = state.startedAtMs;
  state.samples = [];
  state.notes = [];
  state.builds = new Map();
  // StrictMode mounts every effect twice in development, so one "rebuild" per
  // target is the harness rather than the app. Say so rather than let the
  // findings read as churn that is not there.
  if (import.meta.env.DEV)
    state.notes.push(
      "Dev build: StrictMode double-mounts, so expect one extra rebuild per target.",
    );
  observe("longtask", (entry) => {
    push({
      kind: "longtask",
      at: entry.startTime - state.startedAtMs,
      target: entry.name,
      ms: entry.duration,
    });
  });
  observe(
    "event",
    (entry) => {
      push({
        kind: "interaction",
        at: entry.startTime - state.startedAtMs,
        target: entry.name,
        ms: entry.duration,
      });
    },
    { durationThreshold: SLOW_INTERACTION_MS },
  );
  state.rafId = requestAnimationFrame(sampleFrames);
  notify();
}

/** The last finished recording's length, so a stopped session still reports one. */
let lastDurationMs = 0;

/** What has been recorded so far, running or stopped. */
export function perfSnapshot(): PerfSession {
  const durationMs = state.recording ? performance.now() - state.startedAtMs : lastDurationMs;
  return {
    startedAt: state.startedAtIso,
    durationMs,
    frames: state.frames,
    agent: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
    cores: typeof navigator === "undefined" ? 0 : (navigator.hardwareConcurrency ?? 0),
    notes: [...state.notes],
    samples: [...state.samples],
  };
}

export function stopPerfRecording(): PerfSession {
  if (state.recording) {
    lastDurationMs = performance.now() - state.startedAtMs;
    state.recording = false;
    cancelAnimationFrame(state.rafId);
    for (const observer of state.observers) observer.disconnect();
    state.observers = [];
  }
  const session = perfSnapshot();
  for (const listener of listeners) listener();
  return session;
}

/** Console handle: `__t3perf.start()`, do the slow thing, `__t3perf.report()`. */
export function installPerfConsoleHandle(): void {
  if (typeof window === "undefined") return;
  Object.defineProperty(window, "__t3perf", {
    value: { start: startPerfRecording, stop: stopPerfRecording, snapshot: perfSnapshot },
    configurable: true,
  });
}
