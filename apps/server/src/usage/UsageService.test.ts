import { describe, expect, it } from "vite-plus/test";
import {
  UsageService,
  activeProviderMatchesUsage,
  clampUtilization,
  normalizePercentageResource,
  readCursorAccessToken,
} from "./UsageService.ts";

describe("usage normalization", () => {
  it("normalizes provider resources and clamps utilization", () => {
    expect(
      normalizePercentageResource({ usedPercent: 125, resetsAt: "2026-01-01T00:00:00Z" }),
    ).toMatchObject({ used: 125, limit: 100, utilization: 1 });
    expect(clampUtilization(-1)).toBe(0);
    expect(clampUtilization(0.65)).toBe(0.65);
  });

  it("accepts unix-ms and unix-second reset timestamps", () => {
    expect(
      normalizePercentageResource({ usedPercent: 40, resetsAt: 1_770_733_695_000 }),
    ).toMatchObject({
      resetsAt: "2026-02-10T14:28:15.000Z",
    });
    expect(normalizePercentageResource({ usedPercent: 10, resetsAt: "1770733695" })).toMatchObject({
      resetsAt: "2026-02-10T14:28:15.000Z",
    });
  });

  it("matches active T3 provider instance IDs", () => {
    expect(activeProviderMatchesUsage("codex_default", "codex")).toBe(true);
    expect(activeProviderMatchesUsage("claude-code", "claude")).toBe(true);
    expect(activeProviderMatchesUsage("grok", "claude")).toBe(false);
  });
});

describe("UsageService", () => {
  const credentials = (path: string) =>
    path.includes("codex")
      ? JSON.stringify({ tokens: { access_token: "token" } })
      : Promise.reject(new Error("missing"));
  // Keep provider discovery hermetic: no ambient env keys and no real ~/.local/share lookups.
  const hermetic = {
    env: {} as Record<string, string | undefined>,
    readDir: async () => Promise.reject(new Error("missing")),
    sumClaudeListCost: async () => null,
    sumCodexListCost: async () => null,
  };
  it("retains last-known-good usage as stale when a refresh fails", async () => {
    let works = true;
    const service = new UsageService({
      ...hermetic,
      cacheTtlMs: 0,
      readFile: async (path) => credentials(path),
      fetch: async () =>
        works
          ? new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 20 } } }))
          : Promise.reject(new DOMException("timed out", "TimeoutError")),
    });
    expect(Object.keys((await service.getUsage()).providers)).toEqual(["codex"]);
    works = false;
    const stale = await service.getUsage();
    expect(stale.providers.codex?.stale).toBe(true);
    expect(stale.errors).toContainEqual(
      expect.objectContaining({ providerId: "codex", code: "timeout" }),
    );
  });
  it("returns bounded, credential-free API errors", async () => {
    const service = new UsageService({
      ...hermetic,
      readFile: async (path) => credentials(path),
      fetch: async () => new Response("no", { status: 401 }),
    });
    const response = await service.getUsage();
    expect(response.errors).toContainEqual(
      expect.objectContaining({ providerId: "codex", code: "unauthorized" }),
    );
    expect(JSON.stringify(response)).not.toContain("token");
  });

  const codexAuth = (accessToken: string) =>
    JSON.stringify({
      tokens: { access_token: accessToken, refresh_token: "refresh-1", account_id: "acc-1" },
    });

  it("refreshes an expired Codex token reactively on 401 and retries", async () => {
    const writes: Array<{ path: string; contents: string }> = [];
    let usageCalls = 0;
    const service = new UsageService({
      ...hermetic,
      cacheTtlMs: 0,
      readFile: async (path) =>
        path.includes("codex") ? codexAuth("stale") : Promise.reject(new Error("missing")),
      writeFile: async (path, contents) => {
        writes.push({ path, contents });
      },
      fetch: async (url, init) => {
        if (init?.method === "POST")
          return new Response(
            JSON.stringify({ access_token: "fresh", refresh_token: "refresh-2" }),
          );
        usageCalls += 1;
        if (usageCalls === 1) return new Response("no", { status: 401 });
        const auth = String((init?.headers as Record<string, string>).Authorization);
        expect(auth).toBe("Bearer fresh");
        return new Response(
          JSON.stringify({ rate_limit: { primary_window: { used_percent: 42 } } }),
        );
      },
    });
    const response = await service.getUsage();
    expect(Object.keys(response.providers)).toEqual(["codex"]);
    expect(response.providers.codex?.resources.weekly?.used).toBe(42);
    // The rotated token is written back to the CLI credentials file.
    expect(writes[0]?.contents).toContain("fresh");
    expect(writes[0]?.contents).toContain("refresh-2");
  });

  it("surfaces an unauthorized error when the refresh token itself is rejected", async () => {
    const service = new UsageService({
      ...hermetic,
      cacheTtlMs: 0,
      readFile: async (path) =>
        path.includes("codex") ? codexAuth("stale") : Promise.reject(new Error("missing")),
      writeFile: async () => {},
      fetch: async (_url, init) =>
        init?.method === "POST"
          ? new Response("nope", { status: 401 })
          : new Response("no", { status: 401 }),
    });
    const response = await service.getUsage();
    expect(response.providers.codex).toBeUndefined();
    expect(response.errors).toContainEqual(
      expect.objectContaining({ providerId: "codex", code: "unauthorized" }),
    );
  });

  it("reads OpenRouter credits with the key from OpenCode's auth store", async () => {
    const posix = (path: string) => path.replaceAll("\\", "/");
    const service = new UsageService({
      ...hermetic,
      // Fixed home so OpenCode auth path is hermetic on Windows and Unix.
      homeDir: "/tmp/t3-usage-home",
      cacheTtlMs: 0,
      readFile: async (path) =>
        posix(path).endsWith("opencode/auth.json")
          ? JSON.stringify({ openrouter: { type: "api", key: "sk-or-v1-test" } })
          : Promise.reject(new Error("missing")),
      fetch: async (url, init) => {
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          "Bearer sk-or-v1-test",
        );
        if (url.endsWith("/credits"))
          return new Response(JSON.stringify({ data: { total_credits: 20, total_usage: 5 } }));
        if (url.endsWith("/key"))
          return new Response(JSON.stringify({ data: { limit: null, usage: 5 } }));
        return new Response("no", { status: 404 });
      },
    });
    const response = await service.getUsage();
    expect(response.providers.openrouter?.resources.balance).toMatchObject({
      kind: "balance",
      available: 15,
      used: 5,
      limit: 20,
    });
    expect(response.providers.openrouter?.resources.balance?.utilization).toBeUndefined();
    expect(JSON.stringify(response)).not.toContain("sk-or-v1-test");
  });

  it("answers within the response deadline with stale data while a refresh is stuck", async () => {
    let hang = false;
    const service = new UsageService({
      ...hermetic,
      cacheTtlMs: 0,
      responseDeadlineMs: 25,
      readFile: async (path) => credentials(path),
      fetch: (_url, _init) =>
        hang
          ? new Promise<Response>(() => {})
          : Promise.resolve(
              new Response(
                JSON.stringify({ rate_limit: { primary_window: { used_percent: 20 } } }),
              ),
            ),
    });
    // Prime the cache, then wedge the transport (a fetch that never settles and ignores
    // its abort signal — the failure mode behind the panel's eternal "Refreshing…").
    expect(Object.keys((await service.getUsageSafe()).providers)).toEqual(["codex"]);
    hang = true;
    const started = Date.now();
    const response = await service.getUsageSafe({ force: true });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(response.errors).toContainEqual(expect.objectContaining({ code: "timeout" }));
    expect(response.providers.codex?.stale).toBe(true);
  });

  it("abandons a wedged in-flight refresh so later requests recover", async () => {
    let hang = true;
    let nowMs = Date.parse("2026-07-22T12:00:00Z");
    const service = new UsageService({
      ...hermetic,
      cacheTtlMs: 0,
      staleInFlightMs: 50,
      now: () => new Date(nowMs),
      readFile: async (path) => credentials(path),
      fetch: (_url, _init) =>
        hang
          ? new Promise<Response>(() => {})
          : Promise.resolve(
              new Response(
                JSON.stringify({ rate_limit: { primary_window: { used_percent: 20 } } }),
              ),
            ),
    });
    // Without the stale-in-flight guard this promise poisons every future request: they all
    // await the same never-settling refresh. Intentionally not awaited.
    void service.getUsage();
    nowMs += 60;
    hang = false;
    const recovered = await service.getUsage();
    expect(Object.keys(recovered.providers)).toEqual(["codex"]);
    expect(recovered.providers.codex?.resources.weekly?.used).toBe(20);
  });

  it("computes OpenCode Go window spend from the local database", async () => {
    const now = new Date("2026-07-22T12:00:00Z"); // a Wednesday
    const spendCalls: number[] = [];
    const posix = (path: string) => path.replaceAll("\\", "/");
    const service = new UsageService({
      ...hermetic,
      homeDir: "/tmp/t3-usage-home",
      cacheTtlMs: 0,
      now: () => now,
      readDir: async () => ["opencode.db", "auth.json"],
      readFile: async (path) =>
        posix(path).endsWith("opencode/auth.json")
          ? JSON.stringify({ opencode: { type: "wellknown" } })
          : Promise.reject(new Error("missing")),
      openCodeSpend: async (_dbPath, sinceMs) => {
        spendCalls.push(sinceMs);
        return sinceMs === now.getTime() - 5 * 3_600_000 ? 3 : 15;
      },
      fetch: async () => new Response("no", { status: 404 }),
    });
    const response = await service.getUsage();
    const opencode = response.providers.opencode;
    expect(opencode?.plan).toBe("Go");
    expect(opencode?.resources.session).toMatchObject({ used: 3, limit: 12, utilization: 0.25 });
    expect(opencode?.resources.weekly).toMatchObject({ used: 15, limit: 30, utilization: 0.5 });
    expect(opencode?.resources.monthly).toMatchObject({ used: 15, limit: 60, utilization: 0.25 });
    // Weekly window starts on the UTC Monday of the current week.
    expect(spendCalls).toContain(Date.parse("2026-07-20T00:00:00Z"));
    expect(spendCalls).toContain(Date.parse("2026-07-01T00:00:00Z"));
  });

  it("maps Codex secondary_window to weekly with reset timestamp", async () => {
    const service = new UsageService({
      ...hermetic,
      cacheTtlMs: 0,
      readFile: async (path) =>
        path.includes("codex")
          ? JSON.stringify({ tokens: { access_token: "token" } })
          : Promise.reject(new Error("missing")),
      fetch: async () =>
        new Response(
          JSON.stringify({
            plan_type: "plus",
            rate_limit: {
              primary_window: { used_percent: 100, reset_at: 1_700_000_000 },
              secondary_window: { used_percent: 37, reset_at: 1_770_733_695_000 },
            },
          }),
        ),
    });
    const response = await service.getUsage();
    expect(response.providers.codex?.resources.session).toBeUndefined();
    expect(response.providers.codex?.resources.weekly).toMatchObject({
      used: 37,
      resetsAt: "2026-02-10T14:28:15.000Z",
    });
  });

  it("attaches Codex API list-price rows from the local session scan", async () => {
    const service = new UsageService({
      ...hermetic,
      cacheTtlMs: 0,
      sumCodexListCost: async () => ({ todayUsd: 1.25, weekUsd: 8.5 }),
      readFile: async (path) =>
        path.includes("codex")
          ? JSON.stringify({ tokens: { access_token: "token" } })
          : Promise.reject(new Error("missing")),
      fetch: async () =>
        new Response(
          JSON.stringify({
            plan_type: "plus",
            rate_limit: { secondary_window: { used_percent: 12 } },
          }),
        ),
    });
    const resources = (await service.getUsage()).providers.codex?.resources;
    expect(resources?.weekly?.used).toBe(12);
    expect(resources?.listToday).toMatchObject({
      kind: "consumption",
      unit: "USD",
      used: 1.25,
    });
    expect(resources?.listWeek).toMatchObject({ used: 8.5, unit: "USD" });
  });

  it("fetches Cursor plan percent from the dashboard API", async () => {
    const service = new UsageService({
      ...hermetic,
      cacheTtlMs: 0,
      readCursorAccessToken: async () => "cursor-token",
      fetch: async (url, init) => {
        expect(init?.method).toBe("POST");
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer cursor-token");
        if (String(url).includes("GetCurrentPeriodUsage")) {
          return new Response(
            JSON.stringify({
              billingCycleEnd: "1770733695000",
              planUsage: {
                totalPercentUsed: 55,
                autoPercentUsed: 10,
                apiPercentUsed: 20,
                totalSpend: 1200,
                limit: 4000,
              },
            }),
          );
        }
        if (String(url).includes("GetPlanInfo")) {
          return new Response(JSON.stringify({ planInfo: { planName: "Pro" } }));
        }
        return new Response("no", { status: 404 });
      },
    });
    const response = await service.getUsage();
    expect(response.providers.cursor?.plan).toBe("Pro");
    expect(response.providers.cursor?.resources.plan).toMatchObject({
      used: 55,
      utilization: 0.55,
      resetsAt: "2026-02-10T14:28:15.000Z",
    });
    expect(response.providers.cursor?.resources.spend).toBeUndefined();
    expect(response.providers.cursor?.resources.auto?.used).toBe(10);
  });

  it("stores pasted usage tokens, uses them to fetch, and reports sources without secrets", async () => {
    const files = new Map<string, string>();
    const service = new UsageService({
      ...hermetic,
      cacheTtlMs: 0,
      homeDir: "/home/t",
      readFile: async (path) => {
        const contents = files.get(path);
        if (contents === undefined) throw new Error("missing");
        return contents;
      },
      writeFile: async (path, contents) => {
        files.set(path, contents);
      },
      readCursorAccessToken: async () => undefined,
      fetch: async (url, init) => {
        if (String(url).includes("GetCurrentPeriodUsage")) {
          expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
          return new Response(JSON.stringify({ planUsage: { totalPercentUsed: 12 } }));
        }
        return new Response("{}");
      },
    });

    const before = await service.credentialStatuses();
    expect(before.find((entry) => entry.providerId === "cursor")).toMatchObject({
      source: null,
      writable: true,
    });

    await service.setStoredCredential("cursor", "tok-123");
    expect(files.get("/home/t/.t3code/usage-credentials.json")).toContain("tok-123");

    const after = await service.credentialStatuses();
    expect(after.find((entry) => entry.providerId === "cursor")?.source).toBe("stored token");
    expect(JSON.stringify(after)).not.toContain("tok-123");

    const usage = await service.getUsage();
    expect(usage.providers.cursor?.resources.plan?.used).toBe(12);

    await service.setStoredCredential("cursor", null);
    expect(
      (await service.credentialStatuses()).find((entry) => entry.providerId === "cursor")?.source,
    ).toBeNull();
  });
});

describe("burn rate", () => {
  const codexAt = (percent: number) =>
    new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: percent } } }));

  it("measures utilization per hour from its own snapshots and restarts on a reset", async () => {
    let percent = 20;
    let nowMs = Date.parse("2026-08-01T00:00:00.000Z");
    const service = new UsageService({
      env: {},
      readDir: async () => Promise.reject(new Error("missing")),
      sumClaudeListCost: async () => null,
      sumCodexListCost: async () => null,
      cacheTtlMs: 0,
      // @effect-diagnostics-next-line globalDate:off
      now: () => new Date(nowMs),
      readFile: async (path) =>
        path.includes("codex")
          ? JSON.stringify({ tokens: { access_token: "token" } })
          : Promise.reject(new Error("missing")),
      fetch: async () => codexAt(percent),
    });

    await service.getUsage();
    expect(service.burnRatePerHour("codex", "weekly")).toBeNull();

    nowMs += 3_600_000;
    percent = 30;
    await service.getUsage();
    expect(service.burnRatePerHour("codex", "weekly")).toBeCloseTo(0.1, 5);

    // The window reset: utilization fell, so the old points no longer describe it.
    nowMs += 3_600_000;
    percent = 5;
    await service.getUsage();
    expect(service.burnRatePerHour("codex", "weekly")).toBeNull();
  });
});

describe("readCursorAccessToken", () => {
  const noStateDb = { CURSOR_STATE_DB: "/nonexistent/state.vscdb" };

  it("reads the cursor-agent CLI credential a headless box has instead of the IDE DB", async () => {
    const files: Record<string, string> = {
      "/home/root/.cursor/cli-config.json": JSON.stringify({
        auth: { user: { accessToken: "cli-token" } },
      }),
    };
    const token = await readCursorAccessToken("/home/root", noStateDb, async (path) => {
      const contents = files[path];
      if (contents === undefined) throw new Error("missing");
      return contents;
    });
    expect(token).toBe("cli-token");
  });

  it("skips unreadable and tokenless candidates", async () => {
    const files: Record<string, string> = {
      "/home/root/.cursor/cli-config.json": "{ not json",
      "/home/root/.cursor/auth.json": JSON.stringify({ version: 3 }),
      "/home/root/.local/share/cursor-agent/credentials.json": JSON.stringify({
        access_token: "later-token",
      }),
    };
    const token = await readCursorAccessToken("/home/root", noStateDb, async (path) => {
      const contents = files[path];
      if (contents === undefined) throw new Error("missing");
      return contents;
    });
    expect(token).toBe("later-token");
  });

  it("returns undefined when no store holds a token", async () => {
    expect(
      await readCursorAccessToken("/home/root", noStateDb, async () => {
        throw new Error("missing");
      }),
    ).toBeUndefined();
  });
});
