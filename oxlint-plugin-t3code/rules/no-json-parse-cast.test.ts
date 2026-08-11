import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-json-parse-cast");

describe("t3code/no-json-parse-cast", () => {
  rule.invalid(
    "reports a JSON.parse cast to a domain type",
    `
      interface Card { id: string }
      export const read = (raw: string) => JSON.parse(raw) as Card;
    `,
    (output) => {
      assert.match(output, /Schema/);
    },
  );

  rule.invalid(
    "reports laundering through as unknown as",
    `
      interface Card { id: string }
      export const read = (raw: string) => JSON.parse(raw) as unknown as Card;
    `,
  );

  rule.valid(
    "allows as unknown followed by guards",
    `
      export const read = (raw: string) => JSON.parse(raw) as unknown;
    `,
  );

  rule.valid(
    "allows Record<string, unknown>",
    `
      export const read = (raw: string) => JSON.parse(raw) as Record<string, unknown>;
    `,
  );

  rule.valid(
    "allows an uncast parse handed to a decoder",
    `
      declare const decode: (input: unknown) => { id: string };
      export const read = (raw: string) => decode(JSON.parse(raw));
    `,
  );
});
