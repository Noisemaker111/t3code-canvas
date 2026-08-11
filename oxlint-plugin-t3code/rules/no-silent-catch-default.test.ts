import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-silent-catch-default");

describe("t3code/no-silent-catch-default", () => {
  rule.invalid(
    "reports a catch swallowing into an empty array",
    `
      export const list = (api: { list: () => Promise<ReadonlyArray<string>> }) =>
        api.list().catch(() => []);
    `,
    (output) => {
      assert.match(output, /No silent fallback/);
    },
  );

  rule.invalid(
    "reports orElseSucceed with an answer-shaped default",
    `
      import * as Effect from "effect/Effect";

      export const branch = (self: Effect.Effect<string>) =>
        self.pipe(Effect.orElseSucceed(() => ""));
    `,
  );

  rule.valid(
    "allows absence-shaped defaults",
    `
      export const find = (api: { find: () => Promise<string> }) =>
        api.find().catch(() => null);
    `,
  );

  rule.valid(
    "allows a real handler",
    `
      declare const report: (error: unknown) => void;
      export const list = (api: { list: () => Promise<ReadonlyArray<string>> }) =>
        api.list().catch((error) => {
          report(error);
          throw error;
        });
    `,
  );

  rule.valid(
    "allows non-empty defaults",
    `
      export const tiers = (api: { tiers: () => Promise<ReadonlyArray<string>> }) =>
        api.tiers().catch(() => ["fallback-tier"]);
    `,
  );
});
