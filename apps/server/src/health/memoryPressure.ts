/**
 * Whether the box has enough free memory to start optional work right now.
 *
 * Provider snapshots poll five CLIs on a five-minute timer, and each probe
 * shells out — OpenCode alone spawns `--version`, `models --verbose` and
 * `agent list`. That is cheap on an idle box and actively harmful on one
 * already swapping: the spawns land, the results are thrown away because
 * nothing asked for them, and the box has less memory than before.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { parseMeminfo } from "../vps/vpsHostParse.ts";

/** Below this much available memory, optional background work stands down. */
const LOW_MEMORY_FLOOR_BYTES = 768 * 1024 * 1024;

export type MemoryPressure = {
  readonly low: boolean;
  /** Human-readable numbers for the incident log; null when there is nothing to say. */
  readonly detail: string | null;
};

const NO_PRESSURE: MemoryPressure = { low: false, detail: null };

const formatMiB = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))}MiB`;

/**
 * A box whose /proc/meminfo is missing or unparseable (macOS, Windows, a
 * container without procfs) reports no pressure. This gate exists to protect
 * the VPS; guessing "under pressure" everywhere else would disable provider
 * probes on every dev machine.
 */
export function evaluateMemoryPressure(meminfo: string | null): MemoryPressure {
  if (meminfo === null) return NO_PRESSURE;
  const memory = parseMeminfo(meminfo);
  if (memory === null) return NO_PRESSURE;
  if (memory.availableBytes >= LOW_MEMORY_FLOOR_BYTES) return NO_PRESSURE;
  return {
    low: true,
    detail:
      `${formatMiB(memory.availableBytes)} available of ${formatMiB(memory.totalBytes)}` +
      (memory.swapTotalBytes > 0 ? `, swap ${formatMiB(memory.swapUsedBytes)} used` : ""),
  };
}

export const readMemoryPressure: Effect.Effect<MemoryPressure, never, FileSystem.FileSystem> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const meminfo = yield* fs
      .readFileString("/proc/meminfo")
      .pipe(Effect.orElseSucceed(() => null));
    return evaluateMemoryPressure(meminfo);
  });
