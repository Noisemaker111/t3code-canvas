import { describe, expect, it } from "@effect/vitest";

import {
  PROVIDER_CREDENTIALS,
  resolveProviderCredential,
  resolveProviderCredentialSource,
  resolveProviderKey,
  storedCredentialsPath,
  USAGE_PROVIDER_IDS,
  type ProviderCredentialContext,
} from "./UsageService.ts";

const HOME = "/home/t3j";

/** A context whose only readable files are the ones handed in. */
const files = (
  contents: Record<string, string>,
  env: Record<string, string | undefined> = {},
): Partial<ProviderCredentialContext> => ({
  homeDir: HOME,
  env,
  readFile: async (path) => {
    const found = contents[path];
    if (found === undefined) throw new Error(`ENOENT: ${path}`);
    return found;
  },
  readCursorAccessToken: async () => undefined,
});

const stored = (keys: Record<string, string>) => ({
  [storedCredentialsPath(HOME)]: JSON.stringify(keys),
});

describe("provider credential table", () => {
  it("covers every usage family exactly once", () => {
    expect([...USAGE_PROVIDER_IDS].toSorted()).toEqual([
      "claude",
      "codex",
      "cursor",
      "grok",
      "opencode",
      "openrouter",
    ]);
  });

  it("marks writable exactly the families the write route accepts", () => {
    const writable = USAGE_PROVIDER_IDS.filter(
      (family) => PROVIDER_CREDENTIALS[family].writable,
    ).toSorted();
    expect(writable).toEqual(["cursor", "grok", "openrouter"]);
  });

  it("gives every writable family an env var to hand a spawned CLI", () => {
    for (const family of USAGE_PROVIDER_IDS) {
      if (!PROVIDER_CREDENTIALS[family].writable) continue;
      expect(PROVIDER_CREDENTIALS[family].envVar).toBeTruthy();
    }
  });
});

describe("resolveProviderCredential", () => {
  it("prefers the environment, then the pasted key, then a file", async () => {
    const openCodeAuth = {
      [`${HOME}/.local/share/opencode/auth.json`]: JSON.stringify({
        openrouter: { key: "from-file" },
      }),
    };

    expect(
      await resolveProviderCredential("openrouter", {
        ...files(
          { ...openCodeAuth, ...stored({ openrouter: "from-store" }) },
          {
            OPENROUTER_API_KEY: "from-env",
          },
        ),
      }),
    ).toEqual({ key: "from-env", source: "env:OPENROUTER_API_KEY" });

    expect(
      await resolveProviderCredential("openrouter", {
        ...files({ ...openCodeAuth, ...stored({ openrouter: "from-store" }) }),
      }),
    ).toEqual({ key: "from-store", source: "stored token" });

    expect(await resolveProviderCredential("openrouter", files(openCodeAuth))).toMatchObject({
      key: "from-file",
    });
  });

  it("treats a blank env var as unset", async () => {
    expect(
      await resolveProviderKey("openrouter", {
        ...files(stored({ openrouter: "from-store" }), { OPENROUTER_API_KEY: "" }),
      }),
    ).toBe("from-store");
  });

  it("is undefined when no source answers", async () => {
    expect(await resolveProviderKey("openrouter", files({}))).toBeUndefined();
  });

  it("resolves each family through its own chain", async () => {
    const context = files(stored({ openrouter: "or", grok: "xai", cursor: "cur" }));
    expect(await resolveProviderKey("openrouter", context)).toBe("or");
    expect(await resolveProviderKey("grok", context)).toBe("xai");
    expect(await resolveProviderKey("cursor", context)).toBe("cur");
  });

  it("reads CLI logins for the families that own their own auth", async () => {
    expect(
      await resolveProviderKey(
        "codex",
        files({
          [`${HOME}/.codex/auth.json`]: JSON.stringify({ tokens: { access_token: "codex-tok" } }),
        }),
      ),
    ).toBe("codex-tok");

    expect(
      await resolveProviderKey(
        "claude",
        files({
          [`${HOME}/.claude/.credentials.json`]: JSON.stringify({
            claudeAiOauth: { accessToken: "claude-tok" },
          }),
        }),
      ),
    ).toBe("claude-tok");
  });

  it("never resolves the Grok CLI login as an xAI API key", async () => {
    const grokCli = files({
      [`${HOME}/.grok/auth.json`]: JSON.stringify({ default: { key: "cli-login" } }),
    });
    // It proves Grok usage is readable...
    expect(await resolveProviderCredentialSource("grok", grokCli)).toBe(`${HOME}/.grok/auth.json`);
    // ...but api.x.ai must never be handed it.
    expect(await resolveProviderKey("grok", grokCli)).toBeUndefined();
  });
});

describe("resolveProviderCredentialSource", () => {
  it("reports the label of the source that answered, never the secret", async () => {
    const source = await resolveProviderCredentialSource("openrouter", {
      ...files(stored({ openrouter: "sk-or-secret" })),
    });
    expect(source).toBe("stored token");
    expect(source).not.toContain("sk-or-secret");
  });

  it("counts a presence-only source that yields no usable key", async () => {
    const context = files({
      [`${HOME}/.local/share/opencode/auth.json`]: JSON.stringify({ anthropic: {} }),
    });
    expect(await resolveProviderCredentialSource("opencode", context)).toBe(
      `${HOME}/.local/share/opencode/auth.json`,
    );
    expect(await resolveProviderKey("opencode", context)).toBeUndefined();
  });

  it("is null when nothing answers", async () => {
    expect(await resolveProviderCredentialSource("cursor", files({}))).toBeNull();
  });
});
