import { describe, expect, it } from "@effect/vitest";

import { makeLaunchPreflight } from "./preflight.ts";
import type { HealthCheck, HealthEnv, HealthFsEnv, HealthReport } from "./types.ts";

const env = (
  overrides: Omit<Partial<HealthEnv>, "fs"> & { fs?: Partial<HealthFsEnv> } = {},
): HealthEnv => ({
  paths: {
    stateDir: "/state",
    worktreeRoot: "/worktrees",
    releaseRoot: "/release",
    repoRoot: null,
  },
  nowMs: () => 0,
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
    diskSpace: async () => ({ freeBytes: 50 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 }),
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

const noRecord = (_report: HealthReport): void => {};

describe("makeLaunchPreflight", () => {
  it("clears a healthy box", async () => {
    const preflight = makeLaunchPreflight(env(), { checks: [check()], record: noRecord });
    expect(await preflight.check()).toBeNull();
  });

  it("blocks on a failing critical check and names it", async () => {
    const preflight = makeLaunchPreflight(env(), {
      checks: [check({ probe: async () => ({ status: "fail", detail: "store is read-only" }) })],
      record: noRecord,
    });
    expect(await preflight.check()).toEqual({
      checkId: "test.check",
      detail: "store is read-only",
    });
  });

  it("does not block on a warning — a warning is never worth refusing work over", async () => {
    const preflight = makeLaunchPreflight(env(), {
      checks: [
        check({ severity: "warn", probe: async () => ({ status: "fail", detail: "no deps" }) }),
        check({ id: "other.check" }),
      ],
      record: noRecord,
    });
    expect(await preflight.check()).toBeNull();
  });

  it("autofixes rather than blocking when the repair is safe", async () => {
    let repaired = false;
    const preflight = makeLaunchPreflight(env(), {
      checks: [
        check({
          probe: async () =>
            repaired ? { status: "ok", detail: "fine" } : { status: "fail", detail: "missing" },
          autofix: {
            describe: "make it",
            run: async () => {
              repaired = true;
            },
          },
        }),
      ],
      record: noRecord,
    });
    expect(await preflight.check()).toBeNull();
    expect(repaired).toBe(true);
  });

  it("probes once per TTL so a tick launching five cards pays for one run", async () => {
    let probes = 0;
    let nowMs = 0;
    const preflight = makeLaunchPreflight(env({ nowMs: () => nowMs }), {
      checks: [
        check({
          probe: async () => {
            probes += 1;
            return { status: "ok", detail: "fine" };
          },
        }),
      ],
      ttlMs: 30_000,
      record: noRecord,
    });

    await preflight.check();
    await preflight.check();
    await preflight.check();
    expect(probes).toBe(1);

    nowMs = 30_001;
    await preflight.check();
    expect(probes).toBe(2);
  });

  it("records what it found, so a block is in the incident log too", async () => {
    const recorded: HealthReport[] = [];
    const preflight = makeLaunchPreflight(env(), {
      checks: [check({ probe: async () => ({ status: "fail", detail: "broken" }) })],
      record: (report) => recorded.push(report),
    });
    await preflight.check();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.checks[0]?.detail).toBe("broken");
  });
});
