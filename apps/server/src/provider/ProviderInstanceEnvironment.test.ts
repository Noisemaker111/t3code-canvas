import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { storedCredentialsPath, type ProviderCredentialContext } from "../usage/UsageService.ts";
import {
  mergeProviderInstanceEnvironment,
  resolveProviderInstanceEnvironment,
  withResolvedProviderKeys,
} from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        ],
        { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
      ),
    ).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
    });
  });
});

const HOME = "/home/t3j";

/** Only the pasted-key store answers; every file source misses. */
const storedKeys = (keys: Record<string, string>): Partial<ProviderCredentialContext> => ({
  homeDir: HOME,
  readFile: async (path) => {
    if (path === storedCredentialsPath(HOME)) return JSON.stringify(keys);
    throw new Error(`ENOENT: ${path}`);
  },
  readCursorAccessToken: async () => undefined,
});

describe("withResolvedProviderKeys", () => {
  effectIt.effect("fills every family's env var from one pasted key each", () =>
    Effect.gen(function* () {
      const env = yield* withResolvedProviderKeys(
        { PATH: "/bin" },
        storedKeys({ openrouter: "sk-or", grok: "xai", cursor: "cur" }),
      );
      expect(env).toMatchObject({
        OPENROUTER_API_KEY: "sk-or",
        XAI_API_KEY: "xai",
        CURSOR_ACCESS_TOKEN: "cur",
        PATH: "/bin",
      });
    }),
  );

  effectIt.effect("leaves a value the environment already carries alone", () =>
    Effect.gen(function* () {
      const env = yield* withResolvedProviderKeys(
        { OPENROUTER_API_KEY: "sk-or-instance", XAI_API_KEY: "xai-instance" },
        storedKeys({ openrouter: "sk-or-stored", grok: "xai-stored" }),
      );
      expect(env.OPENROUTER_API_KEY).toBe("sk-or-instance");
      expect(env.XAI_API_KEY).toBe("xai-instance");
    }),
  );

  effectIt.effect("replaces a blank inherited value, which is how an unset env file reads", () =>
    Effect.gen(function* () {
      const env = yield* withResolvedProviderKeys(
        { OPENROUTER_API_KEY: "" },
        storedKeys({ openrouter: "sk-or" }),
      );
      expect(env.OPENROUTER_API_KEY).toBe("sk-or");
    }),
  );

  effectIt.effect("sets nothing when no family has a key", () =>
    Effect.gen(function* () {
      const env = yield* withResolvedProviderKeys({ PATH: "/bin" }, storedKeys({}));
      expect(env).toEqual({ PATH: "/bin" });
    }),
  );
});

describe("resolveProviderInstanceEnvironment", () => {
  effectIt.effect("lets an instance variable win over the pasted key", () =>
    Effect.gen(function* () {
      const env = yield* resolveProviderInstanceEnvironment(
        [{ name: "OPENROUTER_API_KEY", value: "sk-or-instance", sensitive: true }],
        { baseEnv: { PATH: "/bin" }, credentials: storedKeys({ openrouter: "sk-or-stored" }) },
      );
      expect(env.OPENROUTER_API_KEY).toBe("sk-or-instance");
    }),
  );

  effectIt.effect("hands the pasted key to an instance that sets none", () =>
    Effect.gen(function* () {
      const env = yield* resolveProviderInstanceEnvironment(undefined, {
        baseEnv: { PATH: "/bin" },
        credentials: storedKeys({ openrouter: "sk-or-stored" }),
      });
      expect(env.OPENROUTER_API_KEY).toBe("sk-or-stored");
    }),
  );
});
