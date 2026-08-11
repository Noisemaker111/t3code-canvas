import { describe, expect, it } from "@effect/vitest";

import { runPrePushGuard, scanContent, scanPath, scanSize } from "./prePushGuard.ts";

const io = (files: Record<string, string>) => ({
  size: async (absolutePath: string) => {
    const key = Object.keys(files).find((name) => absolutePath.endsWith(name));
    return key === undefined ? null : Buffer.byteLength(files[key] ?? "");
  },
  read: async (absolutePath: string) => {
    const key = Object.keys(files).find((name) => absolutePath.endsWith(name));
    return key === undefined ? null : (files[key] ?? null);
  },
});

describe("scanPath", () => {
  it("blocks the files that are secrets by name", () => {
    expect(scanPath("apps/.env")?.reason).toContain("environment secrets");
    expect(scanPath("config/t3j.env")).not.toBeNull();
    expect(scanPath(".env.production")).not.toBeNull();
    expect(scanPath("certs/server.pem")?.reason).toContain("key or certificate");
    expect(scanPath("home/id_rsa")).not.toBeNull();
  });

  it("leaves the documented shape of a secrets file alone", () => {
    expect(scanPath(".env.example")).toBeNull();
    expect(scanPath("config/t3j.env.example")).toBeNull();
    expect(scanPath("src/env.ts")).toBeNull();
    expect(scanPath("docs/SECRETS.md")).toBeNull();
  });
});

describe("scanContent", () => {
  it("finds a private key block and real token shapes", () => {
    expect(scanContent("a.txt", "-----BEGIN OPENSSH PRIVATE KEY-----")).not.toBeNull();
    expect(scanContent("a.txt", "AKIAIOSFODNN7EXAMPLE")).not.toBeNull();
    expect(scanContent("a.txt", `ghp_${"a".repeat(36)}`)?.reason).toContain("GitHub token");
    expect(scanContent("a.txt", `sk-ant-${"x".repeat(24)}`)?.reason).toContain("Anthropic");
  });

  it("does not fire on the words alone — a guard that cries wolf gets turned off", () => {
    expect(scanContent("a.ts", "const apiKey = process.env.API_KEY;")).toBeNull();
    expect(scanContent("a.md", "Set your token in /etc/t3j.env, never in the repo.")).toBeNull();
    expect(scanContent("a.ts", 'expect(token).toBe("ghp_short");')).toBeNull();
  });
});

describe("scanSize", () => {
  it("blocks a file too big to belong in a commit", () => {
    expect(scanSize("core.dump", 20 * 1024 * 1024)?.reason).toContain("20.0MB");
    expect(scanSize("src/app.ts", 4_000)).toBeNull();
  });
});

describe("runPrePushGuard", () => {
  it("passes a clean worktree", async () => {
    const findings = await runPrePushGuard({
      cwd: "/w",
      paths: ["src/app.ts", "README.md"],
      io: io({ "src/app.ts": "export const a = 1;", "README.md": "# hi" }),
    });
    expect(findings).toEqual([]);
  });

  it("blocks a token dumped into an ordinary-looking file", async () => {
    const findings = await runPrePushGuard({
      cwd: "/w",
      paths: ["debug/output.log"],
      io: io({ "debug/output.log": `token=ghp_${"b".repeat(36)}\n` }),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe("debug/output.log");
  });

  it("never reads a file already blocked by its name", async () => {
    let reads = 0;
    const findings = await runPrePushGuard({
      cwd: "/w",
      paths: [".env"],
      io: {
        size: async () => 10,
        read: async () => {
          reads += 1;
          return "";
        },
      },
    });
    expect(findings).toHaveLength(1);
    expect(reads).toBe(0);
  });

  it("skips paths it cannot read rather than inventing a finding", async () => {
    const findings = await runPrePushGuard({
      cwd: "/w",
      paths: ["deleted.ts"],
      io: { size: async () => null, read: async () => null },
    });
    expect(findings).toEqual([]);
  });

  it("reports every offending file, not just the first", async () => {
    const findings = await runPrePushGuard({
      cwd: "/w",
      paths: [".env", "keys/id_ed25519", "src/app.ts"],
      io: io({ ".env": "A=1", "keys/id_ed25519": "x", "src/app.ts": "ok" }),
    });
    expect(findings.map((finding) => finding.path)).toEqual([".env", "keys/id_ed25519"]);
  });
});
