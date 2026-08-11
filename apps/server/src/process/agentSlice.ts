/**
 * AgentSlice — contain agent child processes in the capped cgroup.
 *
 * The board server and the agent work it launches used to share one cgroup
 * (`/system.slice/t3j.service`): when concurrent agent runs filled it, the
 * kernel throttled or oom-killed the server together with the offenders and
 * the board went unreachable. `systemd/t3j-agents.slice` bounds agent work,
 * but a slice only contains what enters it — this module is the entry. It
 * rewrites an agent spawn into `systemd-run --scope --slice=…`, which
 * registers its own PID in the scope and then execve()s the payload: same
 * PID, so kill, PTY and stdio semantics are unchanged.
 *
 * Active only where containment is real: linux, root, and the server itself
 * running as a systemd service (systemd sets `INVOCATION_ID`). Everywhere
 * else (local dev, CI, tests) every helper is a passthrough. A systemd box
 * with no `systemd-run` fails the spawn loudly rather than degrading in
 * silence.
 *
 * @module process/agentSlice
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { recordDegradation } from "../health/incidentLog.ts";

/** Shape of `resolveSpawnCommand`'s result; `shell` disables wrapping. */
export interface AgentSliceSpawnCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell?: boolean | string | undefined;
}

export interface AgentSliceRuntime {
  readonly slice: string;
  /** Seconds after which systemd kills an agent scope, or null for no cap. */
  readonly maxRuntimeSec: number | null;
}

export interface AgentSliceProbeInput {
  readonly uid: number | null;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Same env var `scripts/box-slot.sh` reads; empty string is the typed opt-out. */
const SLICE_ENV = "T3J_AGENT_SLICE";
const DEFAULT_SLICE = "t3j-agents.slice";
/** Empty string disables the cap; anything unparseable falls back to the default. */
const MAX_RUNTIME_ENV = "T3J_AGENT_MAX_RUNTIME_SEC";
// Nothing an agent legitimately runs outlives half a day. Processes that do are
// abandoned, and abandoned ones are not free: on 7 Aug 2026 a `tsgo` left over
// from a session 29 hours earlier held 64% of a core, alongside five stale
// `opencode` processes and an 18-hour `journalctl`. Load sat at 20 on four
// cores, which starved the deploy — `git fetch` alone went over the app's 120s
// check timeout. Nothing on the box reaped them because nothing owned them.
// A scope with no deadline is a leak with a PID; systemd already knows how to
// enforce one, so the cap belongs on the scope rather than in a sweeper that
// would have to guess what is still wanted.
// Twelve hours still left abandoned typechecks on the box overnight. Four is
// long enough for a real agent session and short enough that a forgotten
// `tsgo` or hung CLI is reaped before the next deploy.
const DEFAULT_MAX_RUNTIME_SEC = 4 * 60 * 60;
const SYSTEMD_RUN = "systemd-run";
/** The Claude SDK runs these through node instead of exec'ing them; a shell shim would break. */
const SCRIPT_SUFFIXES = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"];

let cachedRuntime: AgentSliceRuntime | null | undefined;
let scopeSequence = 0;
let shimDir: string | null = null;
const shimPaths = new Map<string, string>();

/** Test seam: forget probed state so a test can vary the environment. */
export function resetAgentSliceForTest(): void {
  cachedRuntime = undefined;
  shimDir = null;
  shimPaths.clear();
}

/**
 * Pure probe, exported for tests; the module caches one result per process.
 * `INVOCATION_ID` is set by systemd for the service's own process — it is
 * both the "systemd exists" and the "we are the managed service" signal, and
 * systemd implies linux, so no platform check is needed. `getuid` existing
 * already excludes Windows.
 */
export function probeAgentSliceRuntime(input: AgentSliceProbeInput): AgentSliceRuntime | null {
  const configured = input.env[SLICE_ENV];
  if (configured !== undefined && configured.trim() === "") return null;
  if (input.uid !== 0) return null;
  if (!input.env["INVOCATION_ID"]) return null;
  return {
    slice: configured?.trim() || DEFAULT_SLICE,
    maxRuntimeSec: resolveMaxRuntimeSec(input.env[MAX_RUNTIME_ENV]),
  };
}

/** Exported for tests: the cap is off for "", and bad input never disables it. */
export function resolveMaxRuntimeSec(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_MAX_RUNTIME_SEC;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_RUNTIME_SEC;
}

/** The scope arguments both spawn paths share, in the order systemd-run takes them. */
function scopeProperties(runtime: AgentSliceRuntime): ReadonlyArray<string> {
  return runtime.maxRuntimeSec === null
    ? []
    : [`--property=RuntimeMaxSec=${runtime.maxRuntimeSec}`];
}

function agentSliceRuntime(): AgentSliceRuntime | null {
  if (cachedRuntime === undefined) {
    cachedRuntime = probeAgentSliceRuntime({
      uid: typeof process.getuid === "function" ? process.getuid() : null,
      env: process.env,
    });
  }
  return cachedRuntime;
}

function scopeLabel(raw: string): string {
  const base = raw.slice(raw.lastIndexOf("/") + 1);
  const safe = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return safe === "" ? "agent" : safe;
}

/** Pure rewrite, exported for tests; `inAgentSlice` supplies the probed runtime. */
export function wrapAgentSpawn(
  runtime: AgentSliceRuntime,
  spawn: AgentSliceSpawnCommand,
  unit: string,
): AgentSliceSpawnCommand {
  return {
    command: SYSTEMD_RUN,
    args: [
      "--quiet",
      "--scope",
      "--collect",
      `--slice=${runtime.slice}`,
      ...scopeProperties(runtime),
      `--unit=${unit}`,
      "--",
      spawn.command,
      ...spawn.args,
    ],
    shell: spawn.shell,
  };
}

/**
 * Rewrite a resolved spawn command into the agent slice. Passthrough when
 * containment is off or for `shell: true` commands, where the wrapper would
 * change what the shell parses.
 */
export function inAgentSlice(spawn: AgentSliceSpawnCommand): AgentSliceSpawnCommand {
  if (spawn.shell) return spawn;
  const runtime = agentSliceRuntime();
  if (runtime === null) return spawn;
  scopeSequence += 1;
  const unit = `t3j-agent-${scopeLabel(spawn.command)}-${process.pid}-${scopeSequence}`;
  return wrapAgentSpawn(runtime, spawn, unit);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Pure shim body, exported for tests. `$$` keeps concurrent unit names unique. */
export function renderAgentSliceShim(
  runtime: AgentSliceRuntime,
  label: string,
  executablePath: string,
): string {
  return [
    "#!/bin/sh",
    `exec ${SYSTEMD_RUN} --quiet --scope --collect ${[
      `--slice=${runtime.slice}`,
      ...scopeProperties(runtime),
    ]
      .map(shellQuote)
      .join(" ")} "--unit=t3j-agent-${label}-$$" -- ${shellQuote(executablePath)} "$@"`,
    "",
  ].join("\n");
}

/**
 * For callers that can only pass an executable path (the Claude Agent SDK,
 * Playwright): a script that exec-chains through systemd-run into the slice.
 * Returns the original path when containment is off, when the path is a
 * script the SDK would run through node, or when the shim cannot be written —
 * the last is recorded as a degradation, never silent.
 */
export const agentSliceExecutable = Effect.fn("agentSliceExecutable")(function* (
  label: string,
  executablePath: string,
) {
  const runtime = agentSliceRuntime();
  if (runtime === null) return executablePath;
  if (SCRIPT_SUFFIXES.some((suffix) => executablePath.endsWith(suffix))) return executablePath;
  const safe = scopeLabel(label);
  const key = `${safe}\n${executablePath}`;
  const existing = shimPaths.get(key);
  if (existing !== undefined) return existing;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.gen(function* () {
    if (shimDir === null) {
      shimDir = yield* fileSystem.makeTempDirectory({ prefix: "t3j-agent-slice-" });
    }
    const shimPath = path.join(shimDir, `${safe}-${shimPaths.size}`);
    yield* fileSystem.writeFileString(
      shimPath,
      renderAgentSliceShim(runtime, safe, executablePath),
    );
    yield* fileSystem.chmod(shimPath, 0o755);
    shimPaths.set(key, shimPath);
    return shimPath;
  }).pipe(
    Effect.catch((cause) => {
      recordDegradation({
        id: "agent-slice",
        title: "Agent processes are not contained",
        detail: `could not write the ${safe} slice shim: ${cause.message}; ${safe} runs in the server cgroup`,
      });
      return Effect.succeed(executablePath);
    }),
  );
});
