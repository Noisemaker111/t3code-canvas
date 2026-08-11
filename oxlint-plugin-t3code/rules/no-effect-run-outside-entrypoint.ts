import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

// Program edges where running a fiber to completion is the point. The *With
// runners are the sanctioned callback-boundary bridge and stay legal everywhere.
const ENTRYPOINT_PATTERN = /(?:^|\/)(?:bin|main)\.[cm]?[jt]s$|\/(?:cli|scripts|integration)\//u;

const BLOCKING_RUNNERS = new Set([
  "runCallback",
  "runFork",
  "runPromise",
  "runPromiseExit",
  "runSync",
  "runSyncExit",
]);

// Existing escapes are tracked debt (the Hermes Promise island). The rule
// permits no net-new occurrences in these files; unlisted files must have zero.
const LEGACY_BASELINE = new Map<string, number>([
  ["apps/server/src/kanban/hermes/HermesBrainLayer.ts", 5],
  ["apps/server/src/kanban/hermes/executor.ts", 1],
  ["apps/server/src/kanban/hermes/liveBoardApi.ts", 1],
  ["apps/server/src/kanban/hermes/operationStore.ts", 10],
  ["apps/web/test/environmentHttpTest.ts", 1],
  ["packages/client-runtime/src/state/runtime.ts", 1],
]);

const baselineFor = (filename: string): number => {
  const normalized = filename.replaceAll("\\", "/");
  for (const [suffix, count] of LEGACY_BASELINE) {
    if (normalized.endsWith(suffix)) return count;
  }
  return 0;
};

const blockingRunnerName = (callee: unknown): Option.Option<string> => {
  const expression = unwrapExpression(callee);
  if (Option.isNone(expression) || expression.value.type !== "MemberExpression") {
    return Option.none();
  }

  const object = unwrapExpression(expression.value.object);
  if (!isIdentifier(object, "Effect")) return Option.none();

  return Option.filter(getPropertyName(expression.value.property), (method) =>
    BLOCKING_RUNNERS.has(method),
  );
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow running Effect fibers mid-module; compose Effects and run them at the program edge or through the *With callback bridges.",
    },
  },
  create(context) {
    const normalized = context.filename.replaceAll("\\", "/");
    if (TEST_FILE_PATTERN.test(normalized)) return {};
    if (ENTRYPOINT_PATTERN.test(normalized)) return {};

    const allowedCount = baselineFor(normalized);
    let occurrenceCount = 0;

    return {
      CallExpression(node) {
        const runner = blockingRunnerName(node.callee);
        if (Option.isNone(runner)) return;

        occurrenceCount++;
        if (occurrenceCount <= allowedCount) return;

        context.report({
          node: node.callee,
          message: `Do not escape Effect mid-module with Effect.${runner.value}. Return the Effect to the caller, or bridge a callback boundary with Effect.${runner.value}With(context). Fiber running belongs in bin.ts/main.ts/cli/scripts entrypoints.`,
        });
      },
    };
  },
});
