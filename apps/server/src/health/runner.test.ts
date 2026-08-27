import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HEALTH_CHECKS } from "./checks.ts";
import {
  bindHealthIncidentLog,
  recordDegradation,
  recordHealthReport,
  unbindHealthIncidentLog,
} from "./incidentLog.ts";
import { formatHealthReport, runHealthChecks } from "./runner.ts";
import type { HealthCheck, HealthEnv, HealthFsEnv } from "./types.ts";

const GIB = 1024 ** 3;

const env = (
  overrides: Omit<Partial<HealthEnv>, "fs"> & { fs?: Partial<HealthFsEnv> } = {},
): HealthEnv => ({
  paths: {
    stateDir: "/state",
    worktreeRoot: "/worktrees",
    releaseRoot: "/release",
    repoRoot: null,
  },
  nowMs: () => Date.parse("2026-01-01T00:00:00.000Z"),
  nodeVersion: "24.13.1",
  envVar: () => null,
  which: async () => "/usr/bin/claude",
  reachable: async () => true,
  exec: async () => ({ code: 0, output: "" }),
  ...overrides,
  fs: {
    exists: async () => true,
    isWritable: async () => true,
    mkdirp: async () => {},
    readDir: async () => [],
    readFile: async () => null,
    diskSpace: async () => ({ freeBytes: 50 * GIB, totalBytes: 100 * GIB }),
    ...overrides.fs,
  },
});

const check = (over: Partial<HealthCheck> = {}): HealthCheck => ({
  id: "test.check",
  title: "Test check",
  severity: "critical",
  probe: async () => ({ status: "ok", detail: "fine" }),
  ...over,
});

const only = (id: string) => ({ only: [id] });

describe("runHealthChecks", () => {
  it("passes a clean box", async () => {
    const report = await runHealthChecks([check()], env());
    expect(report.ok).toBe(true);
    expect(report.checks[0]?.status).toBe("ok");
  });

  it("a failing critical check fails the run, a warn does not", async () => {
    const failing = check({ probe: async () => ({ status: "fail", detail: "broken" }) });
    expect((await runHealthChecks([failing], env())).ok).toBe(false);
    const warning = check({
      severity: "warn",
      probe: async () => ({ status: "fail", detail: "broken" }),
    });
    expect((await runHealthChecks([warning], env())).ok).toBe(true);
  });

  it("does not run autofixes unless asked", async () => {
    let ran = false;
    const failing = check({
      probe: async () => ({ status: "fail", detail: "broken" }),
      autofix: {
        describe: "fix it",
        run: async () => {
          ran = true;
        },
      },
    });
    await runHealthChecks([failing], env());
    expect(ran).toBe(false);
  });

  it("re-probes after an autofix and reports the verified outcome", async () => {
    let repaired = false;
    const failing = check({
      probe: async () =>
        repaired ? { status: "ok", detail: "fine" } : { status: "fail", detail: "broken" },
      autofix: {
        describe: "fix it",
        run: async () => {
          repaired = true;
          return { detail: "did the repair" };
        },
      },
    });
    const report = await runHealthChecks([failing], env(), { fix: true });
    expect(report.ok).toBe(true);
    expect(report.checks[0]?.fixed).toBe(true);
    expect(report.checks[0]?.statusBeforeFix).toBe("fail");
    expect(report.checks[0]?.fixDetail).toBe("did the repair");
    expect(report.checks[0]?.detail).toContain("did the repair");
    expect(report.checks[0]?.detail).toContain("now: fine");
  });

  it("an autofix that does not clear the probe leaves the check failing", async () => {
    const failing = check({
      probe: async () => ({ status: "fail", detail: "broken" }),
      autofix: { describe: "pretend to fix it", run: async () => {} },
    });
    const report = await runHealthChecks([failing], env(), { fix: true });
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.fixed).toBe(false);
  });

  it("a throwing autofix is reported, not swallowed", async () => {
    const failing = check({
      probe: async () => ({ status: "fail", detail: "broken" }),
      autofix: {
        describe: "explode",
        run: async () => {
          throw new Error("no permission");
        },
      },
    });
    const report = await runHealthChecks([failing], env(), { fix: true });
    expect(report.checks[0]?.fixError).toBe("no permission");
    expect(report.ok).toBe(false);
  });

  it("a throwing probe fails its own check instead of the whole run", async () => {
    const exploding = check({
      probe: async () => {
        throw new Error("statfs blew up");
      },
    });
    const report = await runHealthChecks([exploding, check({ id: "other" })], env());
    expect(report.checks[0]?.detail).toContain("statfs blew up");
    expect(report.checks[1]?.status).toBe("ok");
  });
});

describe("HEALTH_CHECKS", () => {
  it("check ids are unique", () => {
    const ids = HEALTH_CHECKS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("disk.headroom fails before the store can go read-only", async () => {
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      env({ fs: { diskSpace: async () => ({ freeBytes: 0.5 * GIB, totalBytes: 100 * GIB }) } }),
      only("disk.headroom"),
    );
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.detail).toContain("reclaim-disk.sh");
  });

  it("store.writable fails a read-only store and names the remount", async () => {
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      env({ fs: { isWritable: async () => false } }),
      only("store.writable"),
    );
    expect(report.checks[0]?.status).toBe("fail");
    expect(report.checks[0]?.detail).toContain("read-only");
  });

  it("store.writable creates a missing worktree root", async () => {
    const made: string[] = [];
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      env({
        fs: {
          exists: async (path) => made.includes(path),
          mkdirp: async (path) => {
            made.push(path);
          },
        },
      }),
      { ...only("store.writable"), fix: true },
    );
    expect(made).toEqual(["/worktrees"]);
    expect(report.checks[0]?.fixed).toBe(true);
  });

  it("worktree.deps spots a worktree the git fallback left without node_modules", async () => {
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      env({
        fs: {
          // Workspaces live at <root>/<project-slug>/thread-<id>.
          readDir: async (path) =>
            path === "/worktrees" || path.endsWith(`${NodePath.sep}worktrees`)
              ? ["demo"]
              : ["thread-abc"],
          readFile: async (path) =>
            path.endsWith(".git") ? "gitdir: /repo/.git/worktrees/thread-abc" : null,
          exists: async (path) => {
            const norm = path.replace(/\\/g, "/");
            return !norm.includes("/worktrees/demo/thread-abc/node_modules");
          },
        },
      }),
      only("worktree.deps"),
    );
    expect(report.checks[0]?.status).toBe("warn");
    expect(report.checks[0]?.detail).toContain("thread-abc");
  });

  it("worktree.deps does not count project directories as inspected worktrees", async () => {
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      env({
        fs: {
          // Rift snapshots have a real .git directory, so no `gitdir:` pointer
          // resolves and there is no fallback worktree to inspect.
          readDir: async (path) => (path === "/worktrees" ? ["demo", "other"] : ["thread-abc"]),
          readFile: async () => null,
          exists: async () => true,
        },
      }),
      only("worktree.deps"),
    );
    expect(report.checks[0]?.status).toBe("ok");
    expect(report.checks[0]?.detail).toContain("no git-worktree fallbacks");
  });

  const storeEnv = (
    over: {
      freeFraction: number;
      dirty?: ReadonlyArray<string>;
      threads?: ReadonlyArray<string>;
      calls?: string[][];
      exists?: (path: string) => boolean;
    } = { freeFraction: 0.5 },
  ) => {
    const threads = over.threads ?? ["thread-a", "thread-b"];
    const dirty = over.dirty ?? [];
    return env({
      paths: { stateDir: "/state", worktreeRoot: "/worktrees", releaseRoot: null, repoRoot: null },
      exec: async (command, args) => {
        over.calls?.push([command, ...args]);
        if (command === "git" && args.includes("status")) {
          const worktree = args[1] ?? "";
          const isDirty = dirty.some((name) => worktree.endsWith(name));
          return { code: 0, output: isDirty ? " M src/app.ts" : "" };
        }
        return { code: 0, output: "" };
      },
      fs: {
        exists: async (path) => over.exists?.(path) ?? true,
        readDir: async (path) => (path === "/worktrees" ? ["demo"] : threads),
        diskSpace: async () => ({
          freeBytes: over.freeFraction * 100 * GIB,
          totalBytes: 100 * GIB,
        }),
      },
    });
  };

  it("worktree.store offers a fix that names the clean worktrees it would drop", async () => {
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      storeEnv({ freeFraction: 0.01, dirty: ["thread-b"] }),
      only("worktree.store"),
    );
    expect(report.checks[0]?.status).toBe("fail");
    expect(report.checks[0]?.detail).toContain("Fix removes the 1 clean, idle worktree(s)");
    expect(report.checks[0]?.detail).toContain("keeping 1 with uncommitted changes");
    expect(HEALTH_CHECKS.find((check) => check.id === "worktree.store")?.autofix).toBeDefined();
  });

  it("worktree.store's fix runs the worktree reclaim on a full store", async () => {
    const calls: string[][] = [];
    await runHealthChecks(HEALTH_CHECKS, storeEnv({ freeFraction: 0.01, calls }), {
      ...only("worktree.store"),
      fix: true,
    });
    expect(
      calls.some(
        (call) =>
          call[0] === "env" &&
          call.includes("T3J_WORKTREE_IDLE_MIN=20") &&
          call.includes("--worktrees") &&
          call.some((part) => part.endsWith("reclaim-disk.sh")),
      ),
    ).toBe(true);
  });

  it("worktree.store's fix reclaims clean trees at the warn count, not only when full", async () => {
    const calls: string[][] = [];
    const threads = ["thread-a", "thread-b", "thread-c", "thread-d", "thread-e", "thread-f"];
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      storeEnv({ freeFraction: 0.5, threads, calls }),
      { ...only("worktree.store"), fix: true },
    );
    expect(report.checks[0]?.status).toBe("warn");
    expect(report.checks[0]?.detail).toContain("accumulating");
    expect(report.checks[0]?.fixDetail ?? report.checks[0]?.detail).toMatch(
      /husk|reclaimed|worktree reclaim|dirty/i,
    );
    expect(calls.some((call) => call.includes("--worktrees"))).toBe(true);
    expect(calls.some((call) => call.includes("T3J_WORKTREE_IDLE_MIN=20"))).toBe(true);
  });

  it("worktree.store's fix leaves worktrees alone when the store is merely tight", async () => {
    const calls: string[][] = [];
    await runHealthChecks(
      HEALTH_CHECKS,
      storeEnv({ freeFraction: 0.1, threads: ["thread-a"], calls }),
      { ...only("worktree.store"), fix: true },
    );
    // Tight space alone does not pass --worktrees (or the shorter idle env).
    const reclaim = calls.filter((call) => call.some((part) => part.endsWith("reclaim-disk.sh")));
    expect(reclaim).toHaveLength(1);
    expect(reclaim[0]?.[0]).toBe("bash");
    expect(reclaim[0]?.some((part) => part.endsWith("reclaim-disk.sh"))).toBe(true);
    expect(reclaim[0]?.includes("--worktrees")).toBe(false);
  });

  it("worktree.store never offers to delete a store that is all dirty worktrees", async () => {
    const calls: string[][] = [];
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      storeEnv({ freeFraction: 0.01, dirty: ["thread-a", "thread-b"], calls }),
      { ...only("worktree.store"), fix: true },
    );
    expect(report.checks[0]?.status).toBe("fail");
    expect(report.checks[0]?.detail).toContain("every worktree has uncommitted changes");
    expect(report.checks[0]?.detail).toContain("thread-a");
    // The script still runs — it also reclaims releases and caches — and its own
    // guard is what keeps every one of these worktrees in place.
    expect(calls.some((call) => call.includes("--worktrees"))).toBe(true);
    expect(report.checks[0]?.fixed).toBe(false);
  });

  it("worktree.store treats a git status it cannot read as dirty", async () => {
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      env({
        paths: {
          stateDir: "/state",
          worktreeRoot: "/worktrees",
          releaseRoot: null,
          repoRoot: null,
        },
        exec: async () => ({ code: 128, output: "not a git repository" }),
        fs: {
          readDir: async (path) => (path === "/worktrees" ? ["demo"] : ["thread-a"]),
          diskSpace: async () => ({ freeBytes: 1 * GIB, totalBytes: 100 * GIB }),
        },
      }),
      only("worktree.store"),
    );
    expect(report.checks[0]?.detail).toContain("every worktree has uncommitted changes");
  });

  it("a repair falls back to the deploy checkout when the box copy is absent", async () => {
    const calls: string[][] = [];
    await runHealthChecks(
      HEALTH_CHECKS,
      env({
        paths: {
          stateDir: "/state",
          worktreeRoot: "/worktrees",
          releaseRoot: null,
          repoRoot: "/opt/vps-code",
        },
        exec: async (command, args) => {
          calls.push([command, ...args]);
          return { code: 0, output: "" };
        },
        fs: {
          exists: async (path) => {
            const norm = path.replace(/\\/g, "/");
            return !norm.startsWith("/usr/local/lib/t3j");
          },
          readDir: async () => [],
          diskSpace: async () => ({ freeBytes: 0.5 * GIB, totalBytes: 100 * GIB }),
        },
      }),
      { ...only("disk.headroom"), fix: true },
    );
    const expectedDeploy = NodePath.join("/opt/vps-code", "deploy", "reclaim-disk.sh");
    expect(calls.some((c) => c[0] === "bash" && c[1] === expectedDeploy)).toBe(true);
  });

  it("a repair with neither copy on the box says where it looked", async () => {
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      env({
        paths: {
          stateDir: "/state",
          worktreeRoot: "/worktrees",
          releaseRoot: null,
          repoRoot: "/opt/vps-code",
        },
        fs: {
          exists: async (path) => !path.replace(/\\/g, "/").endsWith("reclaim-disk.sh"),
          readDir: async () => [],
          diskSpace: async () => ({ freeBytes: 0.5 * GIB, totalBytes: 100 * GIB }),
        },
      }),
      { ...only("disk.headroom"), fix: true },
    );
    expect(report.checks[0]?.fixError?.replace(/\\/g, "/")).toContain(
      "/usr/local/lib/t3j/reclaim-disk.sh",
    );
    expect(report.checks[0]?.fixError?.replace(/\\/g, "/")).toContain(
      "/opt/vps-code/deploy/reclaim-disk.sh",
    );
  });

  it("agent.cli fails when no harness is installed", async () => {
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      env({ which: async () => null }),
      only("agent.cli"),
    );
    expect(report.ok).toBe(false);
  });

  it("agent.cli labels agent as grok when version says grok", async () => {
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      env({
        which: async (binary) =>
          binary === "agent" || binary === "grok" ? `/usr/local/bin/${binary}` : null,
        exec: async (_cmd, args) => {
          if (args[0] === "--version") {
            return { code: 0, output: "grok 1.0.0 (abc) [stable]\n" };
          }
          return { code: 0, output: "" };
        },
      }),
      only("agent.cli"),
    );
    expect(report.checks[0]?.status).toBe("ok");
    expect(report.checks[0]?.detail).toMatch(/grok/);
    expect(report.checks[0]?.detail).not.toContain("cursor-agent");
  });

  it("project.checkout fails detached HEAD and Fix checks out main when clean", async () => {
    const calls: string[][] = [];
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      env({
        paths: {
          stateDir: "/state",
          worktreeRoot: "/root/projects/.worktrees",
          releaseRoot: null,
          repoRoot: null,
        },
        fs: {
          exists: async (path) =>
            path === "/root/projects" ||
            path === "/root/projects/vps-code" ||
            path === "/root/projects/vps-code/.git" ||
            path.endsWith(".git"),
          readDir: async (path) => (path === "/root/projects" ? ["vps-code", ".worktrees"] : []),
        },
        exec: async (command, args) => {
          calls.push([command, ...args]);
          if (command === "git" && args.includes("status")) {
            return { code: 0, output: "## HEAD (no branch)\n" };
          }
          if (command === "git" && args.includes("checkout")) {
            return { code: 0, output: "Switched to branch 'main'\n" };
          }
          return { code: 0, output: "" };
        },
      }),
      { ...only("project.checkout"), fix: true },
    );
    expect(report.checks[0]?.statusBeforeFix).toBe("fail");
    expect(report.checks[0]?.fixDetail).toContain("healed");
    expect(calls.some((c) => c.includes("checkout") && c.includes("main"))).toBe(true);
  });

  it("host.load warns when load is high vs nproc", async () => {
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      env({
        fs: {
          readFile: async (path) => (path === "/proc/loadavg" ? "8.00 7.00 6.00 1/1 1\n" : null),
        },
        exec: async (command) =>
          command === "nproc" ? { code: 0, output: "4\n" } : { code: 0, output: "" },
      }),
      only("host.load"),
    );
    expect(report.checks[0]?.status).toBe("warn");
    expect(report.checks[0]?.detail).toContain("elevated");
  });

  it("node.engine warns on a major mismatch with the shipped engines field", async () => {
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      env({
        nodeVersion: "22.22.2",
        fs: { readFile: async () => JSON.stringify({ engines: { node: "^24.13.1" } }) },
      }),
      only("node.engine"),
    );
    expect(report.checks[0]?.status).toBe("warn");
    expect(report.checks[0]?.detail).toContain("24.13.1");
  });

  it("net.egress names a blocked host as a wall", async () => {
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      env({ reachable: async (url) => !url.includes("npmjs") }),
      only("net.egress"),
    );
    expect(report.checks[0]?.detail).toContain("registry.npmjs.org");
    expect(report.checks[0]?.detail).toContain("network wall");
  });
  it("codex.home stays quiet on a box without codex", async () => {
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      env({ which: async () => null }),
      only("codex.home"),
    );
    expect(report.checks[0]?.status).toBe("ok");
  });

  it("codex.home reports what the doctor script found, and offers to run it", async () => {
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      env({
        paths: {
          stateDir: "/state",
          worktreeRoot: null,
          releaseRoot: null,
          repoRoot: "/opt/vps-code",
        },
        exec: async () => ({ code: 1, output: "CODEX_HOME db path is a dangling symlink" }),
      }),
      only("codex.home"),
    );
    expect(report.checks[0]?.status).toBe("warn");
    expect(report.checks[0]?.detail).toContain("dangling symlink");
  });

  it("codex.home runs the doctor script when asked to fix", async () => {
    const calls: string[][] = [];
    await runHealthChecks(
      HEALTH_CHECKS,
      env({
        paths: {
          stateDir: "/state",
          worktreeRoot: null,
          releaseRoot: null,
          repoRoot: "/opt/vps-code",
        },
        exec: async (command, args) => {
          calls.push([command, ...args]);
          return { code: calls.length === 1 ? 1 : 0, output: "" };
        },
      }),
      { ...only("codex.home"), fix: true },
    );
    const doctor = NodePath.join("/opt/vps-code", "deploy", "codex-home-doctor.sh");
    expect(calls[0]).toEqual(["bash", doctor, "--check"]);
    expect(calls[1]).toEqual(["bash", doctor]);
  });

  it("forge.cli fails a box with no gh, before a card is launched onto it", async () => {
    const report = await runHealthChecks(HEALTH_CHECKS, env({ which: async () => null }), {
      only: ["forge.cli"],
    });
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.detail).toContain("open a PR");
  });

  it("forge.cli accepts glab as well as gh", async () => {
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      env({ which: async (binary) => (binary === "glab" ? "/usr/bin/glab" : null) }),
      only("forge.cli"),
    );
    expect(report.checks[0]?.status).toBe("ok");
  });

  it("forge.auth fails an unauthenticated gh and names the token", async () => {
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      env({
        which: async (binary) => (binary === "gh" ? "/usr/bin/gh" : null),
        exec: async () => ({ code: 1, output: "You are not logged into any GitHub hosts" }),
      }),
      only("forge.auth"),
    );
    expect(report.checks[0]?.status).toBe("fail");
    expect(report.checks[0]?.detail).toContain("GH_TOKEN");
  });

  it("forge.auth stays quiet when there is no forge CLI to authenticate", async () => {
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      env({ which: async () => null, exec: async () => ({ code: 1, output: "" }) }),
      only("forge.auth"),
    );
    expect(report.checks[0]?.status).toBe("ok");
  });

  it("forge.cli's fix says why it could not run on a box with no deploy checkout", async () => {
    const report = await runHealthChecks(HEALTH_CHECKS, env({ which: async () => null }), {
      ...only("forge.cli"),
      fix: true,
    });
    expect(report.checks[0]?.fixed).toBe(false);
    expect(report.checks[0]?.fixError).toContain("T3CODE_VPS_REPO_PATH");
  });

  it("a repair script that exits non-zero surfaces its output as the fix error", async () => {
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      env({
        paths: {
          stateDir: "/state",
          worktreeRoot: null,
          releaseRoot: null,
          repoRoot: "/opt/vps-code",
        },
        which: async () => null,
        exec: async () => ({ code: 7, output: "apt: could not resolve archive.ubuntu.com" }),
      }),
      { ...only("forge.cli"), fix: true },
    );
    expect(report.checks[0]?.fixError).toContain("exited 7");
    expect(report.checks[0]?.fixError).toContain("archive.ubuntu.com");
  });

  it("hermes.tiers warns a box that has no way to serve the brain", async () => {
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      env({ which: async () => null }),
      only("hermes.tiers"),
    );
    expect(report.checks[0]?.status).toBe("warn");
    expect(report.checks[0]?.detail).toContain("Settings → Connections → API keys");
  });

  it("hermes.tiers lists what can serve, including the auth.json fallback", async () => {
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      env({
        which: async (binary) => (binary === "grok" ? "/root/.grok/bin/grok" : null),
        envVar: (name) => (name === "HOME" ? "/root" : null),
        fs: {
          readFile: async (path) =>
            path.endsWith("auth.json") ? JSON.stringify({ openrouter: { key: "sk-or-x" } }) : null,
        },
      }),
      only("hermes.tiers"),
    );
    expect(report.checks[0]?.status).toBe("ok");
    expect(report.checks[0]?.detail).toContain("xai (cached login only)");
    expect(report.checks[0]?.detail).toContain("openrouter (");
    expect(report.checks[0]?.detail).toContain("auth.json");
  });

  it("hermes.tiers counts the key pasted in API keys settings", async () => {
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      env({
        which: async () => null,
        envVar: (name) => (name === "HOME" ? "/root" : null),
        fs: {
          readFile: async (path) =>
            path.endsWith("usage-credentials.json")
              ? JSON.stringify({ openrouter: "sk-or-x" })
              : null,
        },
      }),
      only("hermes.tiers"),
    );
    expect(report.checks[0]?.status).toBe("ok");
    expect(report.checks[0]?.detail).toContain("openrouter (stored token)");
  });

  it("canvas.images warns when its OpenAI key is missing", async () => {
    const report = await runHealthChecks(HEALTH_CHECKS, env(), only("canvas.images"));
    expect(report.checks[0]?.status).toBe("warn");
    expect(report.checks[0]?.detail).toContain("OPENAI_API_KEY");
    expect(report.checks[0]?.detail).toContain("/etc/t3j.env");
  });

  it("canvas.images passes when its OpenAI key is set", async () => {
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      env({ envVar: (name) => (name === "OPENAI_API_KEY" ? "sk-test" : null) }),
      only("canvas.images"),
    );
    expect(report.checks[0]?.status).toBe("ok");
  });

  it("git.identity fails when git cannot resolve an author, and sets one", async () => {
    const calls: string[][] = [];
    const report = await runHealthChecks(
      HEALTH_CHECKS,
      env({
        exec: async (command, args) => {
          calls.push([command, ...args]);
          const configured = calls.some((call) => call.includes("--global"));
          return configured
            ? { code: 0, output: "T3J board <t3j@localhost> 0 +0000" }
            : { code: 128, output: "unable to auto-detect email address" };
        },
      }),
      { ...only("git.identity"), fix: true },
    );
    expect(report.checks[0]?.statusBeforeFix).toBe("fail");
    expect(report.checks[0]?.fixed).toBe(true);
    expect(calls[0]).toEqual(["git", "var", "GIT_COMMITTER_IDENT"]);
  });
});

describe("runtime.incidents", () => {
  const withLog = async (use: () => Promise<void>) => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runtime-incidents-"));
    bindHealthIncidentLog(baseDir);
    try {
      await use();
    } finally {
      unbindHealthIncidentLog();
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  };

  it("passes when nothing degraded", async () => {
    await withLog(async () => {
      const report = await runHealthChecks(HEALTH_CHECKS, env(), only("runtime.incidents"));
      expect(report.checks[0]?.status).toBe("ok");
    });
  });

  it("surfaces a degradation the running server recorded, counted by id", async () => {
    await withLog(async () => {
      recordDegradation({
        id: "launch.model-routing",
        title: "Model routing fell back",
        detail: "card-1: no candidates",
        at: "2025-12-31T23:00:00.000Z",
      });
      recordDegradation({
        id: "launch.model-routing",
        title: "Model routing fell back",
        detail: "card-2: no candidates",
        at: "2025-12-31T23:30:00.000Z",
      });
      const report = await runHealthChecks(HEALTH_CHECKS, env(), only("runtime.incidents"));
      expect(report.checks[0]?.status).toBe("warn");
      expect(report.checks[0]?.detail).toContain("degraded.launch.model-routing ×2");
      expect(report.checks[0]?.detail).toContain("card-2: no candidates");
    });
  });

  it("ignores incidents a check of its own already owns, and anything older than a day", async () => {
    await withLog(async () => {
      recordHealthReport({
        at: "2025-12-31T23:00:00.000Z",
        ok: false,
        checks: [
          {
            id: "disk.headroom",
            title: "Disk",
            severity: "critical",
            status: "fail",
            detail: "full",
          },
        ],
      });
      recordDegradation({
        id: "launch.model-routing",
        title: "old",
        detail: "last week",
        at: "2025-12-20T00:00:00.000Z",
      });
      const report = await runHealthChecks(HEALTH_CHECKS, env(), only("runtime.incidents"));
      expect(report.checks[0]?.status).toBe("ok");
    });
  });
});

describe("formatHealthReport", () => {
  it("renders a verdict line with the failing count", async () => {
    const report = await runHealthChecks(
      [check({ probe: async () => ({ status: "fail", detail: "broken" }) })],
      env(),
    );
    expect(formatHealthReport(report)).toContain("FAIL  test.check — broken");
    expect(formatHealthReport(report)).toContain("t3 health: FAILED (1 failing");
  });
});
