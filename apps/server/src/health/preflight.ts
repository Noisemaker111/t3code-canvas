/**
 * The gate between a sick box and a spent turn.
 *
 * A card launched onto a box with a read-only worktree store or no agent CLI
 * does not fail fast — it starts a session that discovers the problem as a
 * broken build, and the model pays to rediscover it. Preflight runs the
 * critical checks first (fixing what is safe to fix), and a launch that would
 * have burned tokens becomes a card with a reason on it.
 *
 * Only `critical` checks block. A warning is worth reporting and never worth
 * refusing work over.
 *
 * @module health/preflight
 */
import { HEALTH_CHECKS } from "./checks.ts";
import { healthPathsFromEnvironment, makeHealthEnv } from "./env.ts";
import { recordHealthReport } from "./incidentLog.ts";
import { runHealthChecks } from "./runner.ts";
import type { HealthCheck, HealthEnv } from "./types.ts";

/** A launch that runs several cards in one tick must not re-probe per card. */
const DEFAULT_TTL_MS = 30_000;

export interface PreflightBlock {
  readonly checkId: string;
  readonly detail: string;
}

export interface LaunchPreflight {
  /** `null` when the box is fit to launch onto. */
  readonly check: () => Promise<PreflightBlock | null>;
}

export interface MakeLaunchPreflightOptions {
  readonly checks?: ReadonlyArray<HealthCheck>;
  readonly ttlMs?: number;
  readonly record?: typeof recordHealthReport;
}

export function makeLaunchPreflight(
  env: HealthEnv,
  options: MakeLaunchPreflightOptions = {},
): LaunchPreflight {
  const checks = options.checks ?? HEALTH_CHECKS;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const record = options.record ?? recordHealthReport;
  const criticalIds = checks
    .filter((check) => check.severity === "critical")
    .map((check) => check.id);

  let cached: { readonly atMs: number; readonly block: PreflightBlock | null } | null = null;

  return {
    check: async () => {
      const nowMs = env.nowMs();
      if (cached && nowMs - cached.atMs < ttlMs) return cached.block;

      const report = await runHealthChecks(checks, env, { fix: true, only: criticalIds });
      record(report);

      const failing = report.checks.find((outcome) => outcome.status === "fail");
      const block = failing ? { checkId: failing.id, detail: failing.detail } : null;
      cached = { atMs: nowMs, block };
      return block;
    },
  };
}

let shared: LaunchPreflight | null = null;

/** One instance per process, so a tick launching five cards probes once. */
export function sharedLaunchPreflight(stateDir: string): LaunchPreflight {
  shared ??= makeLaunchPreflight(makeHealthEnv(healthPathsFromEnvironment(stateDir)));
  return shared;
}

/** Test seam. */
export function resetSharedLaunchPreflight(): void {
  shared = null;
}
