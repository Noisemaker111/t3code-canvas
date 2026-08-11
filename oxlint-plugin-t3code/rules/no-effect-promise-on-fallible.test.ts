import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-effect-promise-on-fallible");

describe("t3code/no-effect-promise-on-fallible", () => {
  rule.invalid(
    "reports Effect.promise around a fallible call",
    `
      import * as Effect from "effect/Effect";

      export const catalog = Effect.promise(() => fetch("https://example.com/models"));
    `,
    (output) => {
      assert.match(output, /tryPromise/);
    },
  );

  rule.invalid(
    "reports Effect.promise around an async body",
    `
      import * as Effect from "effect/Effect";
      declare const work: () => Promise<void>;

      export const run = Effect.promise(async () => {
        await work();
      });
    `,
  );

  rule.valid(
    "allows dynamic imports",
    `
      import * as Effect from "effect/Effect";

      export const platform = Effect.promise(() => import("node:os"));
    `,
  );

  rule.valid(
    "allows thunks made total with .catch",
    `
      import * as Effect from "effect/Effect";
      declare const read: () => Promise<ReadonlyArray<string>>;

      export const entries = Effect.promise(() => read().catch(() => null));
    `,
  );

  rule.valid(
    "allows *Safe-named contracts",
    `
      import * as Effect from "effect/Effect";
      declare const getUsageSafe: () => Promise<number>;

      export const usage = Effect.promise(() => getUsageSafe());
    `,
  );

  rule.valid(
    "allows Effect.tryPromise",
    `
      import * as Effect from "effect/Effect";

      export const catalog = Effect.tryPromise({
        try: () => fetch("https://example.com/models"),
        catch: (cause) => new Error(String(cause)),
      });
    `,
  );
});
