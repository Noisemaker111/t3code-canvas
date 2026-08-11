/**
 * Probe → autofix → verify, for every check in the registry.
 *
 * The verify step is the point: a fix that is not re-probed is a claim, and a
 * claim is what makes a box look healthy while it is not. A check that has no
 * autofix, or whose autofix did not clear the probe, stays failing and says so.
 *
 * @module health/runner
 */
import type {
  HealthCheck,
  HealthCheckOutcome,
  HealthEnv,
  HealthProbeResult,
  HealthReport,
} from "./types.ts";

export interface RunHealthOptions {
  /** Run autofixes for failing checks. Off by default: probing is read-only. */
  readonly fix?: boolean;
  /** Only run these check ids. */
  readonly only?: ReadonlyArray<string>;
}

async function probeSafely(check: HealthCheck, env: HealthEnv): Promise<HealthProbeResult> {
  try {
    return await check.probe(env);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { status: "fail", detail: `probe threw: ${detail}` };
  }
}

async function runOne(
  check: HealthCheck,
  env: HealthEnv,
  fix: boolean,
): Promise<HealthCheckOutcome> {
  const first = await probeSafely(check, env);
  const base = {
    id: check.id,
    title: check.title,
    severity: check.severity,
  } as const;

  if (first.status === "ok" || !fix || !check.autofix) {
    return { ...base, status: first.status, detail: first.detail };
  }

  let fixDetail: string | undefined;
  try {
    const fixResult = await check.autofix.run(env);
    if (fixResult && typeof fixResult === "object" && "detail" in fixResult) {
      fixDetail = fixResult.detail;
    }
  } catch (cause) {
    return {
      ...base,
      status: first.status,
      detail: first.detail,
      statusBeforeFix: first.status,
      fixed: false,
      fixError: cause instanceof Error ? cause.message : String(cause),
      ...(fixDetail ? { fixDetail } : {}),
    };
  }

  const second = await probeSafely(check, env);
  const detail =
    fixDetail && fixDetail.length > 0 ? `${fixDetail} · now: ${second.detail}` : second.detail;
  return {
    ...base,
    status: second.status,
    detail,
    statusBeforeFix: first.status,
    fixed: second.status === "ok",
    ...(fixDetail ? { fixDetail } : {}),
  };
}

export async function runHealthChecks(
  checks: ReadonlyArray<HealthCheck>,
  env: HealthEnv,
  options: RunHealthOptions = {},
): Promise<HealthReport> {
  const only = options.only;
  const selected = only ? checks.filter((check) => only.includes(check.id)) : checks;
  const outcomes: HealthCheckOutcome[] = [];
  for (const check of selected) {
    outcomes.push(await runOne(check, env, options.fix === true));
  }
  return {
    at: new Date(env.nowMs()).toISOString(),
    ok: !outcomes.some((outcome) => outcome.severity === "critical" && outcome.status === "fail"),
    checks: outcomes,
  };
}

export function formatHealthReport(report: HealthReport): string {
  const lines = report.checks.map((outcome) => {
    const label = outcome.status === "ok" ? "PASS" : outcome.status === "warn" ? "WARN" : "FAIL";
    const fixed =
      outcome.fixed === true
        ? " (autofixed)"
        : outcome.fixError
          ? ` (autofix failed: ${outcome.fixError})`
          : outcome.fixed === false
            ? " (autofix did not clear it)"
            : "";
    return `  ${label}  ${outcome.id} — ${outcome.detail}${fixed}`;
  });
  const failed = report.checks.filter((o) => o.status === "fail").length;
  const warned = report.checks.filter((o) => o.status === "warn").length;
  const verdict = report.ok
    ? `t3 health: OK (${report.checks.length} checks, ${warned} warning(s))`
    : `t3 health: FAILED (${failed} failing, ${warned} warning(s))`;
  return [...lines, verdict].join("\n");
}
