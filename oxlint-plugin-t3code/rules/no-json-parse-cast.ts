import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

const MESSAGE =
  "JSON.parse output is untrusted. Decode it (Schema.fromJsonString / Schema.decodeUnknown*) instead of casting to a domain type; `as unknown` followed by explicit guards is the only allowed cast.";

// Existing casts are tracked debt. The rule permits no net-new occurrences in
// these files; unlisted files must have zero.
const LEGACY_BASELINE = new Map<string, number>([
  ["apps/mobile/src/persistence/mobile-storage.ts", 1],
  ["apps/server/scripts/cursor-acp-model-mismatch-probe.ts", 1],
  ["apps/server/src/friction/detector.ts", 1],
  ["apps/server/src/friction/frictionStore.ts", 1],
  ["apps/server/src/health/checks.ts", 2],
  ["apps/server/src/health/incidentLog.ts", 1],
  ["apps/server/src/kanban/KanbanStore.ts", 3],
  ["apps/server/src/kanban/budget/budgetStore.ts", 1],
  ["apps/server/src/kanban/hermes/chatStore.ts", 1],
  ["apps/server/src/kanban/hermes/conversationStore.ts", 2],
  ["apps/server/src/kanban/hermes/tickLogStore.ts", 1],
  ["apps/server/src/kanban/hermes/usageLogStore.ts", 2],
  ["apps/server/src/provider/opencodeRuntime.ts", 1],
  ["apps/server/src/sourceControl/GitHubCli.ts", 1],
  ["apps/server/src/sourceControl/statusCheckRollup.ts", 1],
  ["apps/web/src/cloud/primaryCloudLinkState.ts", 1],
  ["apps/web/src/components/canvas/BoardCanvas.tsx", 1],
  ["apps/web/src/components/canvas/panels/PanelLayer.tsx", 1],
  ["apps/web/src/lib/boardSettings.ts", 2],
  ["apps/web/src/uiStateStore.ts", 2],
  ["packages/client-runtime/src/relay/managedRelayState.ts", 1],
  ["packages/client-runtime/src/state/runtime.ts", 1],
  ["packages/client-runtime/src/state/vcs.ts", 1],
  ["scripts/mobile-showcase.ts", 2],
  ["scripts/release-smoke.ts", 1],
]);

const baselineFor = (filename: string): number => {
  const normalized = filename.replaceAll("\\", "/");
  for (const [suffix, count] of LEGACY_BASELINE) {
    if (normalized.endsWith(suffix)) return count;
  }
  return 0;
};

type TypeNode = { readonly type: string } & Record<string, unknown>;

const isAllowedTargetType = (annotation: unknown): boolean => {
  if (typeof annotation !== "object" || annotation === null) return false;
  const node = annotation as TypeNode;
  if (node.type === "TSUnknownKeyword") return true;

  if (node.type !== "TSTypeReference") return false;
  const typeName = node["typeName"] as TypeNode | undefined;
  if (typeName?.type !== "Identifier" || typeName["name"] !== "Record") return false;

  const params = (node["typeArguments"] ?? node["typeParameters"]) as TypeNode | undefined;
  const args = (params?.["params"] as ReadonlyArray<TypeNode> | undefined) ?? [];
  return (
    args.length === 2 && args[0]?.type === "TSStringKeyword" && args[1]?.type === "TSUnknownKeyword"
  );
};

const isJsonParseCall = (expression: unknown): boolean => {
  const unwrapped = unwrapExpression(expression);
  if (Option.isNone(unwrapped) || unwrapped.value.type !== "CallExpression") return false;

  const callee = unwrapExpression(unwrapped.value.callee);
  if (Option.isNone(callee) || callee.value.type !== "MemberExpression") return false;

  const object = unwrapExpression(callee.value.object);
  const property = getPropertyName(callee.value.property);
  return isIdentifier(object, "JSON") && Option.isSome(property) && property.value === "parse";
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow casting JSON.parse results to domain types; decode with Schema instead.",
    },
  },
  create(context) {
    const normalized = context.filename.replaceAll("\\", "/");
    if (TEST_FILE_PATTERN.test(normalized)) return {};

    const allowedCount = baselineFor(normalized);
    let occurrenceCount = 0;

    const check = (node: {
      readonly expression: unknown;
      readonly typeAnnotation: unknown;
    }): void => {
      if (isAllowedTargetType(node.typeAnnotation)) return;
      if (!isJsonParseCall(node.expression)) return;

      occurrenceCount++;
      if (occurrenceCount <= allowedCount) return;

      context.report({ node: node as never, message: MESSAGE });
    };

    return {
      TSAsExpression: check,
      TSTypeAssertion: check,
    };
  },
});
