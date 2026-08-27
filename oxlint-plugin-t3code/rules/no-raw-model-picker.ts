import { defineRule } from "@oxlint/plugins";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const WEB_SRC_DIR = "apps/web/src/";
const UI_PRIMITIVES_DIR = "apps/web/src/components/ui/";
const RAW_PICKER_ELEMENTS = new Set(["select", "datalist"]);

const MESSAGE =
  "Hand-rolled picker: use ProviderModelPicker (apps/web/src/components/chat/ProviderModelPicker.tsx) for provider+model, or the shared Select in components/ui/select for anything else.";

// Existing raw pickers are tracked debt. The rule permits no net-new
// occurrences in these files; unlisted files must have zero.
const LEGACY_BASELINE = new Map<string, number>([
  ["apps/web/src/components/dev/DevGallery.tsx", 1],
  ["apps/web/src/components/kanban/BaseBranchPicker.tsx", 1],
  ["apps/web/src/components/kanban/KanbanBoard.tsx", 1],
  ["apps/web/src/routes/settings.tsx", 1],
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
        "Disallow raw <select>/<datalist> elements in the web app; reuse ProviderModelPicker or the shared Select.",
    },
  },
  create(context) {
    const normalized = context.filename.replaceAll("\\", "/");
    if (TEST_FILE_PATTERN.test(normalized)) return {};
    if (!normalized.includes(WEB_SRC_DIR)) return {};
    if (normalized.includes(UI_PRIMITIVES_DIR)) return {};

    const allowedCount = baselineFor(normalized);
    let occurrenceCount = 0;

    return {
      JSXOpeningElement(node) {
        const name = node.name;
        if (name.type !== "JSXIdentifier" || !RAW_PICKER_ELEMENTS.has(name.name)) return;

        occurrenceCount++;
        if (occurrenceCount <= allowedCount) return;

        context.report({ node: name, message: MESSAGE });
      },
    };
  },
});
