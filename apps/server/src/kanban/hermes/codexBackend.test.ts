import { describe, expect, it } from "@effect/vitest";

import { makeCodexHermesBackend } from "./codexBackend.ts";

const home = "/tmp/hermes-codex-home";

const deps = (input: {
  readonly binaryExists: (command: string) => boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly authFiles?: ReadonlySet<string>;
}) => ({
  childProcessSpawner: {} as never,
  crypto: {} as never,
  cwd: home,
  environment: input.environment,
  binaryExists: input.binaryExists,
  codexAuthExists: async (path: string) => input.authFiles?.has(path) === true,
  runPromise: async <A>(): Promise<A> => {
    throw new Error("these tests never drive a codex turn");
  },
});

describe("makeCodexHermesBackend", () => {
  it("claims the codex driver so an instance of it resolves here", () => {
    const backend = makeCodexHermesBackend(
      deps({ binaryExists: () => true, environment: {} }),
      null,
    );

    expect(backend.tier).toBe("codex");
    expect(String(backend.driver)).toBe("codex");
  });

  it("is unavailable without the binary", async () => {
    const backend = makeCodexHermesBackend(
      deps({ binaryExists: () => false, environment: {} }),
      null,
    );

    expect(await backend.available()).toMatchObject({
      available: false,
      detail: "missing binary: codex",
    });
  });

  it("is unavailable until `codex login` has written auth.json", async () => {
    const unauthed = makeCodexHermesBackend(
      deps({ binaryExists: () => true, environment: { CODEX_HOME: home } }),
      null,
    );

    const before = await unauthed.available();
    expect(before.available).toBe(false);
    expect(before.detail).toContain("codex login");

    const authed = makeCodexHermesBackend(
      deps({
        binaryExists: () => true,
        environment: { CODEX_HOME: home },
        authFiles: new Set([`${home}/auth.json`]),
      }),
      null,
    );
    const after = await authed.available();
    expect(after).toMatchObject({ available: true });
    expect(after.detail).toContain("auth.json");
  });

  it("reads auth from the instance's shadow home before CODEX_HOME", async () => {
    const shadow = `${home}/personal`;
    const backend = makeCodexHermesBackend(
      deps({
        binaryExists: () => true,
        environment: { CODEX_HOME: home },
        authFiles: new Set([`${shadow}/auth.json`]),
      }),
      {
        binaryPath: "codex",
        homePath: "",
        shadowHomePath: shadow,
        launchArgs: "",
      },
    );

    expect(await backend.available()).toMatchObject({ available: true });
  });
});
