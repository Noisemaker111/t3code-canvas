import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-effect-run-outside-entrypoint", {
  filename: "apps/server/src/kanban/SomeService.ts",
});

describe("t3code/no-effect-run-outside-entrypoint", () => {
  rule.invalid(
    "reports a mid-module runPromise escape",
    `
      import * as Effect from "effect/Effect";

      export const readRows = (query: Effect.Effect<ReadonlyArray<string>>) =>
        Effect.runPromise(query);
    `,
    (output) => {
      assert.match(output, /runPromiseWith/);
    },
  );

  rule.invalid(
    "reports runSync buried in a service method",
    `
      import * as Effect from "effect/Effect";

      export const snapshot = () => Effect.runSync(Effect.succeed(1));
    `,
  );

  rule.valid(
    "allows the sanctioned *With callback bridges",
    `
      import * as Effect from "effect/Effect";

      export const bridge = (context: never, effect: Effect.Effect<void>) =>
        Effect.runPromiseWith(context)(effect);
    `,
  );

  rule.valid(
    "allows composing without running",
    `
      import * as Effect from "effect/Effect";

      export const program = Effect.map(Effect.succeed(1), (n) => n + 1);
    `,
  );
});

const entrypointRule = createOxlintRuleHarness("t3code/no-effect-run-outside-entrypoint", {
  filename: "apps/server/src/bin.ts",
});

entrypointRule.valid(
  "allows running fibers at a program entrypoint",
  `
    import * as Effect from "effect/Effect";

    void Effect.runPromise(Effect.succeed(1));
  `,
);

const baselineRule = createOxlintRuleHarness("t3code/no-effect-run-outside-entrypoint", {
  filename: "apps/server/src/kanban/hermes/executor.ts",
});

describe("t3code/no-effect-run-outside-entrypoint baseline", () => {
  baselineRule.valid(
    "allows the frozen legacy count",
    `
      import * as Effect from "effect/Effect";

      export const one = () => Effect.runPromise(Effect.succeed(1));
    `,
  );

  baselineRule.invalid(
    "reports a net-new escape past the frozen count",
    `
      import * as Effect from "effect/Effect";

      export const one = () => Effect.runPromise(Effect.succeed(1));
      export const two = () => Effect.runPromise(Effect.succeed(2));
    `,
  );
});
