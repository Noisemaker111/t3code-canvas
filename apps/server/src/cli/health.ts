/**
 * `t3 health` — what the box can find wrong with itself, and fix.
 *
 * Sibling of `t3 doctor`: doctor exercises core operations against a temp
 * directory to catch a regression, health inspects the live box for the
 * conditions that make sessions fail. Non-zero exit on a failing critical
 * check, so a deploy or a cron can gate on it.
 *
 * @module cli/health
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import { HEALTH_CHECKS } from "../health/checks.ts";
import { healthPathsFromEnvironment, makeHealthEnv } from "../health/env.ts";
import { bindHealthIncidentLog, recordHealthReport } from "../health/incidentLog.ts";
import { formatHealthReport, runHealthChecks } from "../health/runner.ts";

export class HealthChecksFailedError extends Schema.TaggedErrorClass<HealthChecksFailedError>()(
  "HealthChecksFailedError",
  { failedChecks: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `t3 health: ${this.failedChecks.length} critical check(s) failing: ${this.failedChecks.join(", ")}.`;
  }
}

const DEFAULT_STATE_DIR = "/var/lib/t3j/userdata";

export const runHealth = (options: {
  readonly fix: boolean;
  readonly json: boolean;
  readonly stateDir: string | undefined;
}) =>
  Effect.gen(function* () {
    const stateDir = options.stateDir ?? process.env["T3CODE_STATE_DIR"] ?? DEFAULT_STATE_DIR;
    const env = makeHealthEnv(healthPathsFromEnvironment(stateDir));
    bindHealthIncidentLog(stateDir);

    const report = yield* Effect.promise(() =>
      runHealthChecks(HEALTH_CHECKS, env, { fix: options.fix }),
    );
    recordHealthReport(report);

    yield* Console.log(options.json ? JSON.stringify(report, null, 2) : formatHealthReport(report));

    if (!report.ok) {
      return yield* new HealthChecksFailedError({
        failedChecks: report.checks
          .filter((outcome) => outcome.severity === "critical" && outcome.status === "fail")
          .map((outcome) => outcome.id),
      });
    }
  });

export const healthCommand = Command.make("health", {
  fix: Flag.boolean("fix").pipe(
    Flag.withDescription("Run the autofix for every failing check that has one, then re-probe."),
    Flag.withDefault(false),
  ),
  json: Flag.boolean("json").pipe(
    Flag.withDescription("Emit the report as JSON instead of PASS/WARN/FAIL lines."),
    Flag.withDefault(false),
  ),
  stateDir: Flag.string("state-dir").pipe(
    Flag.withDescription(
      "State directory to inspect (defaults to $T3CODE_STATE_DIR, else /var/lib/t3j/userdata).",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Inspect this box for the conditions that make agent sessions fail, and optionally fix them.",
  ),
  Command.withHandler((flags) =>
    runHealth({
      fix: flags.fix,
      json: flags.json,
      stateDir: Option.getOrUndefined(flags.stateDir),
    }),
  ),
);
