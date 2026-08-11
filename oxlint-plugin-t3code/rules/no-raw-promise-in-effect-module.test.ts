import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-raw-promise-in-effect-module");

describe("t3code/no-raw-promise-in-effect-module", () => {
  rule.invalid(
    "reports new Promise in an Effect module",
    `
      import * as Effect from "effect/Effect";

      export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      export const ok = Effect.succeed(1);
    `,
    (output) => {
      assert.match(output, /Effect module/);
    },
  );

  rule.invalid(
    "reports Promise.all in an Effect module",
    `
      import * as Effect from "effect/Effect";

      export const both = (a: Promise<number>, b: Promise<number>) => Promise.all([a, b]);
      export const ok = Effect.succeed(1);
    `,
  );

  rule.invalid(
    "reports a .then chain in an Effect module",
    `
      import * as Schema from "effect/Schema";

      export const readText = (response: Response) => response.text().then((text) => text.trim());
      export const Id = Schema.String;
    `,
  );

  rule.valid(
    "ignores modules that do not import effect",
    `
      export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      export const both = (a: Promise<number>, b: Promise<number>) => Promise.all([a, b]);
    `,
  );

  rule.valid(
    "ignores type-only effect imports",
    `
      import type * as Effect from "effect/Effect";

      export const wait = (ms: number): Promise<void> & { _tag?: Effect.Effect<void> } =>
        new Promise((resolve) => setTimeout(resolve, ms));
    `,
  );

  rule.valid(
    "allows Effect combinators",
    `
      import * as Effect from "effect/Effect";

      export const both = Effect.all([Effect.succeed(1), Effect.succeed(2)], {
        concurrency: "unbounded",
      });
    `,
  );
});
