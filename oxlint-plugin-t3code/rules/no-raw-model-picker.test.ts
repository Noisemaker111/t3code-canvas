import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-raw-model-picker", {
  filename: "apps/web/src/components/settings/HermesSettingsPanel.tsx",
});

describe("t3code/no-raw-model-picker", () => {
  rule.invalid(
    "reports the bespoke datalist model picker regression",
    `
      export function BrainModelField(props: { models: ReadonlyArray<string> }) {
        return (
          <>
            <input list="hermes-models" />
            <datalist id="hermes-models">
              {props.models.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </>
        );
      }
    `,
    (output) => {
      assert.match(output, /ProviderModelPicker/);
    },
  );

  rule.invalid(
    "reports a raw select in settings",
    `
      export function ProviderField() {
        return (
          <select>
            <option value="cursor">Cursor</option>
          </select>
        );
      }
    `,
  );

  rule.valid(
    "allows the shared ProviderModelPicker",
    `
      import { ProviderModelPicker } from "../../chat/ProviderModelPicker";

      export function BrainModelField(props: { instanceId: string; model: string }) {
        return <ProviderModelPicker activeInstanceId={props.instanceId} model={props.model} />;
      }
    `,
  );
});

const nonSettingsRule = createOxlintRuleHarness("t3code/no-raw-model-picker", {
  filename: "apps/web/src/components/kanban/NewPanel.tsx",
});

nonSettingsRule.invalid(
  "reports a raw select anywhere in the web app",
  `
    export function NewPanel(props: { branches: ReadonlyArray<string> }) {
      return (
        <select>
          {props.branches.map((branch) => (
            <option key={branch} value={branch} />
          ))}
        </select>
      );
    }
  `,
);

const baselineRule = createOxlintRuleHarness("t3code/no-raw-model-picker", {
  filename: "apps/web/src/components/kanban/BaseBranchPicker.tsx",
});

describe("t3code/no-raw-model-picker baseline", () => {
  baselineRule.valid(
    "allows the frozen legacy raw select",
    `
      export function BaseBranchPicker(props: { branches: ReadonlyArray<string> }) {
        return (
          <select>
            {props.branches.map((branch) => (
              <option key={branch} value={branch} />
            ))}
          </select>
        );
      }
    `,
  );

  baselineRule.invalid(
    "reports a net-new raw select past the frozen count",
    `
      export function BaseBranchPicker() {
        return (
          <>
            <select />
            <select />
          </>
        );
      }
    `,
  );
});

const uiPrimitivesRule = createOxlintRuleHarness("t3code/no-raw-model-picker", {
  filename: "apps/web/src/components/ui/select.tsx",
});

uiPrimitivesRule.valid(
  "allows the shared Select primitive to render the native element",
  `
    export function Select(props: { children?: unknown }) {
      return <select>{props.children as never}</select>;
    }
  `,
);
