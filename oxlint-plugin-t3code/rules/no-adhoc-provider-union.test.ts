import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-adhoc-provider-union");

describe("t3code/no-adhoc-provider-union", () => {
  rule.invalid(
    "reports the hermesBrainProvider Schema.Literal regression",
    `
      import * as Schema from "effect/Schema";

      export const BoardSettings = Schema.Struct({
        hermesBrainProvider: Schema.Literal("cursor", "xai", "openrouter"),
      });
    `,
    (output) => {
      assert.match(output, /ProviderInstanceId/);
    },
  );

  rule.invalid(
    "reports the hermesBrainProvider type union regression",
    `
      export type HermesBrainProvider = "cursor" | "xai" | "openrouter";
    `,
  );

  rule.invalid(
    "reports a const array promoted to a schema literal union",
    `
      import * as Schema from "effect/Schema";

      const HERMES_BACKENDS = ["cursor", "openrouter"] as const;
      export const HermesBackend = Schema.Literals(HERMES_BACKENDS);
    `,
  );

  rule.invalid(
    "reports an inline Schema.Literals array",
    `
      import * as Schema from "effect/Schema";

      export const Harness = Schema.Literals(["codex", "claudeAgent", "cursor"]);
    `,
  );

  rule.valid(
    "allows routing on ProviderInstanceId",
    `
      import type { ProviderInstanceId } from "@t3tools/contracts";

      export const route = (instanceId: ProviderInstanceId) => instanceId;
    `,
  );

  rule.valid(
    "allows a union that is not purely provider names",
    `
      import * as Schema from "effect/Schema";

      export const TelemetryIdentitySource = Schema.Literals(["codex", "claude", "anonymous"]);
    `,
  );

  rule.valid(
    "allows a const array used for iteration",
    `
      export function normalize(id: string): string {
        for (const providerId of ["codex", "grok", "openrouter", "cursor"] as const) {
          if (id === providerId) return providerId;
        }
        return id;
      }
    `,
  );

  rule.valid(
    "allows a single provider literal",
    `
      import * as Schema from "effect/Schema";

      export const Driver = Schema.Literal("codex");
    `,
  );

  rule.valid(
    "allows legacy declarations that predate the rule",
    `
      export type UsageProviderId = "codex" | "grok" | "openrouter" | "opencode" | "cursor";
    `,
  );
});

const canonicalRule = createOxlintRuleHarness("t3code/no-adhoc-provider-union", {
  filename: "packages/contracts/src/providerInstance.ts",
});

canonicalRule.valid(
  "allows provider vocabulary in the canonical contracts module",
  `
    import * as Schema from "effect/Schema";

    export const KnownDriverKind = Schema.Literals(["codex", "claudeAgent", "cursor"]);
  `,
);

const testFileRule = createOxlintRuleHarness("t3code/no-adhoc-provider-union", {
  filename: "fixture.test.ts",
});

testFileRule.valid(
  "allows provider unions in tests",
  `
    export type Fixture = "cursor" | "xai" | "openrouter";
  `,
);
