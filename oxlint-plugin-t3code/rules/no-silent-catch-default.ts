import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

const MESSAGE =
  'A swallowed failure returning an answer-shaped default ([] / "" / 0 / {}) hides degradation: the caller reads it as a real result. Fail, or surface the degradation (recordDegradation, typed error). See CLAUDE.md → No silent fallback.';

// Existing swallows are tracked debt. The rule permits no net-new occurrences
// in these files; unlisted files must have zero.
const LEGACY_BASELINE = new Map<string, number>([
  ["apps/desktop/src/app/DesktopObservability.ts", 2],
  ["apps/desktop/src/wsl/DesktopWslEnvironment.ts", 2],
  ["apps/mobile/src/features/agent-awareness/remoteRegistration.ts", 1],
  ["apps/mobile/src/features/cloud/managedRelayTokenStore.ts", 1],
  ["apps/server/src/cli/config.ts", 1],
  ["apps/server/src/kanban/ModelBenchRunner.ts", 1],
  ["apps/server/src/kanban/budget/BudgetService.ts", 4],
  ["apps/server/src/kanban/hermes/HermesBrain.ts", 6],
  ["apps/server/src/kanban/hermes/HermesBrainLayer.ts", 1],
  ["apps/server/src/kanban/hermes/liveBoardApi.ts", 1],
  ["apps/server/src/kanban/hermes/openrouterBackend.ts", 1],
  ["apps/server/src/kanban/hermes/programApi.ts", 2],
  ["apps/server/src/kanban/hermes/rulePass.ts", 4],
  ["apps/server/src/maintenance/Maintenance.ts", 2],
  ["apps/server/src/orchestration/Layers/ProjectionPipeline.ts", 1],
  ["apps/server/src/process/externalLauncher.ts", 2],
  ["apps/server/src/provider/Layers/CursorProvider.ts", 1],
  ["apps/server/src/provider/Layers/ProviderService.ts", 2],
  ["apps/server/src/provider/opencodeRuntime.ts", 1],
  ["apps/server/src/provider/providerMaintenance.ts", 1],
  ["apps/server/src/provider/providerStatusCache.ts", 1],
  ["apps/server/src/terminal/Manager.ts", 1],
  ["apps/server/src/usage/UsageService.ts", 2],
  ["apps/server/src/vcs/GitVcsDriverCore.ts", 8],
  ["apps/server/src/vcs/WorktreeReaper.ts", 1],
  ["apps/web/src/lib/modelBench.ts", 1],
  ["scripts/export-brand-icons.ts", 1],
  ["scripts/mobile-showcase.ts", 2],
]);

const baselineFor = (filename: string): number => {
  const normalized = filename.replaceAll("\\", "/");
  for (const [suffix, count] of LEGACY_BASELINE) {
    if (normalized.endsWith(suffix)) return count;
  }
  return 0;
};

const isAnswerShapedDefault = (body: unknown): boolean => {
  const expression = unwrapExpression(body);
  if (Option.isNone(expression)) return false;
  const node = expression.value;

  if (node.type === "ArrayExpression") return node.elements.length === 0;
  if (node.type === "ObjectExpression") return node.properties.length === 0;
  if (node.type === "Literal") return node.value === "" || node.value === 0;
  return false;
};

const swallowHandler = (node: {
  readonly callee: unknown;
  readonly arguments: ReadonlyArray<unknown>;
}): Option.Option<unknown> => {
  const callee = unwrapExpression(node.callee);
  if (Option.isNone(callee) || callee.value.type !== "MemberExpression") return Option.none();

  const property = getPropertyName(callee.value.property);
  if (Option.isNone(property)) return Option.none();

  if (property.value === "catch" && node.arguments.length === 1) {
    return Option.some(node.arguments[0]);
  }
  if (property.value === "orElseSucceed" && node.arguments.length >= 1) {
    return Option.some(node.arguments[node.arguments.length - 1]);
  }
  return Option.none();
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow catch/orElseSucceed handlers that swallow a failure into an answer-shaped default ([], "", 0, {}).',
    },
  },
  create(context) {
    const normalized = context.filename.replaceAll("\\", "/");
    if (TEST_FILE_PATTERN.test(normalized)) return {};

    const allowedCount = baselineFor(normalized);
    let occurrenceCount = 0;

    return {
      CallExpression(node) {
        const handler = swallowHandler(node);
        if (Option.isNone(handler)) return;

        const arrow = handler.value as { readonly type?: string; readonly body?: unknown };
        if (arrow.type !== "ArrowFunctionExpression") return;
        if (!isAnswerShapedDefault(arrow.body)) return;

        occurrenceCount++;
        if (occurrenceCount <= allowedCount) return;

        context.report({ node: node.callee, message: MESSAGE });
      },
    };
  },
});
