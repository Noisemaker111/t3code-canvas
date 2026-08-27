import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const EFFECT_IMPORT_PATTERN = /^(?:effect|@effect\/)/u;
const PROMISE_COMBINATORS = new Set(["all", "allSettled", "any", "race"]);

// effect-smol namespaces whose members legitimately chain (Effect.catch etc.);
// .then on these is not a promise chain.
const EFFECT_NAMESPACES = new Set([
  "Effect",
  "Exit",
  "Fiber",
  "Layer",
  "Option",
  "Result",
  "Schema",
  "Sink",
  "Stream",
]);

// Existing raw-promise code in Effect modules is tracked debt. The rule
// permits no net-new occurrences in these files; unlisted files must have zero.
const LEGACY_BASELINE = new Map<string, number>([
  ["apps/desktop/src/electron/ElectronShell.ts", 1],
  ["apps/mobile/src/features/agent-awareness/remoteRegistration.ts", 1],
  ["apps/mobile/src/features/cloud/CloudAuthProvider.tsx", 2],
  ["apps/mobile/src/features/diffs/nativeReviewDiffHighlighter.ts", 1],
  ["apps/mobile/src/features/review/shikiReviewHighlighter.ts", 5],
  ["apps/mobile/src/features/showcase/ShowcaseCaptureCoordinator.tsx", 2],
  ["apps/mobile/src/features/threads/new-task-flow-provider.tsx", 1],
  ["apps/mobile/src/persistence/mobile-storage.ts", 1],
  ["apps/mobile/src/state/thread-outbox-manager.ts", 3],
  ["apps/mobile/src/state/use-composer-drafts.ts", 1],
  ["apps/mobile/src/state/use-thread-outbox-drain.ts", 2],
  ["apps/server/scripts/cursor-acp-model-mismatch-probe.ts", 2],
  ["apps/server/src/kanban/hermes/acpBackends.ts", 2],
  ["apps/server/src/kanban/hermes/liveBoardApi.ts", 3],
  ["apps/server/src/provider/Layers/ClaudeProvider.ts", 1],
  ["apps/server/src/terminal/BunPtyAdapter.ts", 1],
  ["apps/web/src/browser/browserRecording.ts", 6],
  ["apps/web/src/cloud/managedAuth.tsx", 2],
  ["apps/web/src/cloud/relayClientInstallDialog.ts", 1],
  ["apps/web/src/components/ChatMarkdown.tsx", 3],
  ["apps/web/src/components/ChatView.logic.ts", 2],
  ["apps/web/src/components/ChatView.tsx", 8],
  ["apps/web/src/components/files/projectFilesQueryState.ts", 1],
  ["apps/web/src/components/kanban/KanbanBoard.tsx", 4],
  ["apps/web/src/components/preview/PreviewAutomationHosts.tsx", 3],
  ["apps/web/src/components/preview/previewAutomationRequestConsumer.ts", 1],
  ["apps/web/src/components/preview/usePreviewSession.ts", 1],
  ["apps/web/src/components/settings/ConnectionsSettings.tsx", 1],
  ["apps/web/src/components/settings/SettingsPanels.tsx", 1],
  ["apps/web/src/composerDraftStore.ts", 1],
  ["apps/web/src/environments/primary/auth.ts", 2],
  ["apps/web/src/hooks/useCopyToClipboard.ts", 1],
  ["packages/client-runtime/src/relay/managedRelayState.ts", 1],
  ["packages/client-runtime/src/state/runtime.ts", 4],
]);

const baselineFor = (filename: string): number => {
  const normalized = filename.replaceAll("\\", "/");
  for (const [suffix, count] of LEGACY_BASELINE) {
    if (normalized.endsWith(suffix)) return count;
  }
  return 0;
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw Promise construction/combination (.then, new Promise, Promise.all/race) in modules that import effect; stay in Effect.",
    },
  },
  create(context) {
    const normalized = context.filename.replaceAll("\\", "/");
    if (TEST_FILE_PATTERN.test(normalized)) return {};

    const allowedCount = baselineFor(normalized);
    let importsEffect = false;
    const buffered: Array<{ readonly node: never; readonly message: string }> = [];

    const buffer = (node: unknown, message: string): void => {
      buffered.push({ node: node as never, message });
    };

    return {
      ImportDeclaration(node) {
        const source = node.source;
        const importKind = (node as { readonly importKind?: string }).importKind;
        if (importKind === "type") return;
        if (typeof source.value === "string" && EFFECT_IMPORT_PATTERN.test(source.value)) {
          importsEffect = true;
        }
      },
      NewExpression(node) {
        if (isIdentifier(unwrapExpression(node.callee), "Promise")) {
          buffer(
            node.callee,
            "new Promise in an Effect module: use Effect.callback for callback interop, or keep the module Promise-free.",
          );
        }
      },
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (Option.isNone(callee) || callee.value.type !== "MemberExpression") return;

        const object = unwrapExpression(callee.value.object);
        const property = getPropertyName(callee.value.property);
        if (Option.isNone(property)) return;

        if (isIdentifier(object, "Promise") && PROMISE_COMBINATORS.has(property.value)) {
          buffer(
            node.callee,
            `Promise.${property.value} in an Effect module: use Effect.all / Effect.race with a concurrency option.`,
          );
          return;
        }

        if (
          property.value === "then" &&
          !(
            Option.isSome(object) &&
            object.value.type === "Identifier" &&
            EFFECT_NAMESPACES.has(object.value.name)
          )
        ) {
          buffer(
            node.callee,
            ".then chain in an Effect module: use Effect.map / Effect.flatMap, or bridge once at the boundary with Effect.tryPromise.",
          );
        }
      },
      "Program:exit"() {
        if (!importsEffect) return;
        let occurrenceCount = 0;
        for (const report of buffered) {
          occurrenceCount++;
          if (occurrenceCount <= allowedCount) continue;
          context.report(report);
        }
      },
    };
  },
});
