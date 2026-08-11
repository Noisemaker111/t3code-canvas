import { describe, expect, it } from "@effect/vitest";

import {
  isStoredCredentialProvider,
  readStoredCredential,
  storedCredentialsPath,
  writeStoredCredential,
  type StoredCredentialsIo,
} from "./UsageService.ts";

/** In-memory stand-in for the credentials file, keyed by path like the real one. */
const memoryIo = (seed?: string): StoredCredentialsIo & { readonly files: Map<string, string> } => {
  const files = new Map<string, string>();
  if (seed !== undefined) files.set(storedCredentialsPath("/home/t3j"), seed);
  return {
    files,
    homeDir: "/home/t3j",
    readFile: async (path) => {
      const contents = files.get(path);
      if (contents === undefined) throw new Error(`ENOENT: ${path}`);
      return contents;
    },
    writeFile: async (path, contents) => {
      files.set(path, contents);
    },
  };
};

describe("stored credentials", () => {
  it("reads back what it wrote, and clears with null", async () => {
    const io = memoryIo();
    expect(await readStoredCredential("openrouter", io)).toBeUndefined();

    await writeStoredCredential("openrouter", "  sk-or-test  ", io);
    expect(await readStoredCredential("openrouter", io)).toBe("sk-or-test");
    expect(io.files.get(storedCredentialsPath("/home/t3j"))).toContain("sk-or-test");

    await writeStoredCredential("openrouter", null, io);
    expect(await readStoredCredential("openrouter", io)).toBeUndefined();
  });

  it("keeps other families when one is written", async () => {
    const io = memoryIo();
    await writeStoredCredential("grok", "xai-key", io);
    await writeStoredCredential("openrouter", "or-key", io);
    expect(await readStoredCredential("grok", io)).toBe("xai-key");
    expect(await readStoredCredential("openrouter", io)).toBe("or-key");
  });

  it("treats a malformed or blank store as no key rather than throwing", async () => {
    expect(await readStoredCredential("openrouter", memoryIo("not json"))).toBeUndefined();
    expect(
      await readStoredCredential("openrouter", memoryIo(JSON.stringify({ openrouter: "   " }))),
    ).toBeUndefined();
  });

  it("accepts only the families the write route allows", () => {
    expect(isStoredCredentialProvider("openrouter")).toBe(true);
    expect(isStoredCredentialProvider("claude")).toBe(false);
  });
});
