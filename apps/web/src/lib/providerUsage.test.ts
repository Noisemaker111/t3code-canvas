import { describe, expect, it } from "vite-plus/test";
import {
  burnRatePerHour,
  formatHours,
  formatProviderName,
  formatResourceLabel,
  hoursUntilExhausted,
  hoursUntilReset,
  isProviderUsageUsable,
  providerForSelection,
  providerUsageUnusableReason,
  readUsageHistory,
  recordUsageSnapshot,
  sortUsageResources,
  usageColor,
  utilization,
  usageProviderIdForSelection,
  type UsageEntry,
  type UsageResponse,
} from "./providerUsage";

class FakeStorage implements Pick<Storage, "getItem" | "setItem"> {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

describe("provider usage display helpers", () => {
  it("uses the requested utilization color thresholds", () => {
    expect(usageColor(0.59)).toBe("#22c55e");
    expect(usageColor(0.6)).toBe("#eab308");
    expect(usageColor(0.8)).toBe("#ef4444");
  });
  it("matches active provider families and normalizes resources", () => {
    expect(providerForSelection([{ id: "codex", resources: {} }], "codex_default")?.id).toBe(
      "codex",
    );
    expect(providerForSelection([{ id: "claude", resources: {} }], "claudeAgent")?.id).toBe(
      "claude",
    );
    expect(providerForSelection([{ id: "openrouter", resources: {} }], "openrouter_team")?.id).toBe(
      "openrouter",
    );
    expect(usageProviderIdForSelection("claude_openrouter")).toBe("claude");
    expect(utilization({ used: 150, limit: 100 })).toBe(1);
    expect(utilization({ utilization: Number.NaN })).toBeNull();
  });

  it("uses polished provider and resource labels", () => {
    expect(formatProviderName("openrouter")).toBe("OpenRouter");
    expect(formatProviderName("claudeAgent")).toBe("Claude");
    expect(formatProviderName("example_provider")).toBe("Example Provider");
    expect(formatResourceLabel("weeklyOpus")).toBe("Weekly Opus");
    expect(formatResourceLabel("totalUsage")).toBe("Total usage");
  });

  it("sorts usage windows consistently and keeps list prices last", () => {
    const entries = [
      ["listWeek", { kind: "consumption", unit: "USD", used: 12 }],
      ["weekly", { kind: "consumption", unit: "percent", used: 40, limit: 100 }],
      ["session", { kind: "consumption", unit: "percent", used: 10, limit: 100 }],
    ] as const;
    expect(sortUsageResources(entries).map(([id]) => id)).toEqual([
      "session",
      "weekly",
      "listWeek",
    ]);
  });
});

describe("usage history and burn rate", () => {
  const providers: ReadonlyArray<UsageEntry> = [
    {
      id: "codex",
      resources: {
        session: { kind: "consumption", unit: "percent", used: 10 },
      },
    },
  ];

  it("records snapshots to storage and prunes points older than 24h", () => {
    const storage = new FakeStorage();
    const t0 = Date.parse("2026-07-24T00:00:00Z");
    recordUsageSnapshot(storage, providers, t0);
    const stale = recordUsageSnapshot(
      storage,
      [
        {
          id: "codex",
          resources: {
            session: { kind: "consumption", unit: "percent", used: 40 },
          },
        },
      ],
      t0 + 25 * 3_600_000,
    );
    expect(stale["codex:session"]).toHaveLength(1);
    expect(stale["codex:session"]?.[0]?.value).toBe(40);
    expect(readUsageHistory(storage)).toEqual(stale);
  });

  it("computes burn rate per hour from the oldest to newest snapshot", () => {
    const storage = new FakeStorage();
    const t0 = Date.parse("2026-07-24T00:00:00Z");
    recordUsageSnapshot(storage, providers, t0);
    recordUsageSnapshot(
      storage,
      [
        {
          id: "codex",
          resources: {
            session: { kind: "consumption", unit: "percent", used: 30 },
          },
        },
      ],
      t0 + 2 * 3_600_000,
    );
    const history = readUsageHistory(storage);
    expect(burnRatePerHour(history, "codex", "session", "consumption")).toBe(10);
    // Balance resources aren't rated (credit top-ups make direction ambiguous).
    expect(burnRatePerHour(history, "codex", "session", "balance")).toBeNull();
  });

  it("returns null burn rate with fewer than two points or a non-increasing value", () => {
    const storage = new FakeStorage();
    recordUsageSnapshot(storage, providers, Date.parse("2026-07-24T00:00:00Z"));
    expect(
      burnRatePerHour(readUsageHistory(storage), "codex", "session", "consumption"),
    ).toBeNull();
  });

  it("projects hours until reset and hours until exhausted", () => {
    const now = Date.parse("2026-07-24T00:00:00Z");
    expect(hoursUntilReset(new Date(now + 3 * 3_600_000).toISOString(), now)).toBeCloseTo(3);
    expect(hoursUntilReset(new Date(now - 1000).toISOString(), now)).toBeNull();
    expect(hoursUntilReset(undefined, now)).toBeNull();

    expect(hoursUntilExhausted({ used: 50, limit: 100 }, 10)).toBe(5);
    expect(hoursUntilExhausted({ used: 100, limit: 100 }, 10)).toBeNull();
    expect(hoursUntilExhausted({ used: 50, limit: 100 }, null)).toBeNull();
    expect(hoursUntilExhausted({ used: 50 }, 10)).toBeNull();
  });

  it("formats hours as minutes, hours, or days", () => {
    expect(formatHours(0.2)).toBe("12m");
    expect(formatHours(5)).toBe("5h");
    expect(formatHours(72)).toBe("3d");
  });
});

describe("providerUsageUnusableReason", () => {
  it("fails open when usage has not loaded yet", () => {
    expect(providerUsageUnusableReason(null, "opencode")).toBeNull();
    expect(isProviderUsageUsable(undefined, "codex")).toBe(true);
  });

  it("blocks non-OpenCode providers on missing or unauthorized credentials", () => {
    const usage: UsageResponse = {
      providers: {},
      errors: [
        {
          providerId: "codex",
          code: "no_credentials",
          message: "Codex CLI login is not available.",
        },
      ],
    };
    expect(providerUsageUnusableReason(usage, "codex")).toBe("Codex CLI login is not available.");
    expect(providerUsageUnusableReason(usage, "codex_personal")).toBe(
      "Codex CLI login is not available.",
    );
    expect(providerUsageUnusableReason(usage, "claude")).toBeNull();
  });

  it("keeps Cursor selectable when only the usage token is missing", () => {
    const usage: UsageResponse = {
      providers: {},
      errors: [
        { providerId: "cursor", code: "no_credentials", message: "Cursor login is not available." },
      ],
    };
    expect(providerUsageUnusableReason(usage, "cursor")).toBeNull();
    expect(providerUsageUnusableReason(usage, "cursor_default")).toBeNull();
  });

  it("keeps Claude selectable when only the usage OAuth is missing", () => {
    const usage: UsageResponse = {
      providers: {},
      errors: [
        {
          providerId: "claude",
          code: "no_credentials",
          message: "Claude CLI login is not available.",
        },
      ],
    };
    expect(providerUsageUnusableReason(usage, "claude")).toBeNull();
    expect(providerUsageUnusableReason(usage, "claudeAgent")).toBeNull();
  });

  it("still blocks Claude when the usage token was rejected", () => {
    const usage: UsageResponse = {
      providers: {},
      errors: [{ providerId: "claude", code: "unauthorized", message: "Claude rejected the key." }],
    };
    expect(providerUsageUnusableReason(usage, "claudeAgent")).toBe("Claude rejected the key.");
  });

  it("still blocks Cursor when the token it did find was rejected", () => {
    const usage: UsageResponse = {
      providers: {},
      errors: [{ providerId: "cursor", code: "unauthorized", message: "Cursor rejected the key." }],
    };
    expect(providerUsageUnusableReason(usage, "cursor")).toBe("Cursor rejected the key.");
  });

  it("blocks zero credit balances", () => {
    const usage: UsageResponse = {
      providers: {
        openrouter: {
          displayName: "OpenRouter",
          resources: {
            balance: { kind: "balance", unit: "USD", available: 0 },
          },
        },
      },
    };
    expect(providerUsageUnusableReason(usage, "openrouter")).toBe("No credits remaining.");
  });

  it("blocks when any consumption window is exhausted (not only when all are)", () => {
    const usage: UsageResponse = {
      providers: {
        claude: {
          displayName: "Claude",
          resources: {
            session: {
              kind: "consumption",
              unit: "percent",
              used: 100,
              limit: 100,
              utilization: 1,
              resetsAt: "2026-07-28T17:40:00.000Z",
            },
            weekly: {
              kind: "consumption",
              unit: "percent",
              used: 40,
              limit: 100,
              utilization: 0.4,
            },
          },
        },
      },
    };
    const reason = providerUsageUnusableReason(usage, "claudeAgent");
    expect(reason).toMatch(/^Usage limit reached\./);
    expect(reason).toContain("Resets");
    expect(reason).not.toContain("(session)");
  });

  it("blocks Codex when the weekly window is spent", () => {
    const usage: UsageResponse = {
      providers: {
        codex: {
          displayName: "Codex",
          resources: {
            weekly: {
              kind: "consumption",
              unit: "percent",
              used: 99,
              limit: 100,
              utilization: 0.99,
              resetsAt: "2026-07-28T17:40:00.000Z",
            },
          },
        },
      },
    };
    const reason = providerUsageUnusableReason(usage, "codex");
    expect(reason).toMatch(/^Usage limit reached\./);
    expect(reason).toContain("Resets");
    expect(reason).not.toContain("(weekly)");
  });

  it("allows OpenCode free / non-Go and ignores missing usage DB credentials", () => {
    const free: UsageResponse = {
      providers: {
        opencode: {
          displayName: "OpenCode",
          resources: {
            session: { kind: "consumption", unit: "USD", used: 0 },
          },
        },
      },
    };
    expect(providerUsageUnusableReason(free, "opencode")).toBeNull();

    const missingDb: UsageResponse = {
      providers: {},
      errors: [
        {
          providerId: "opencode",
          code: "no_credentials",
          message: "OpenCode CLI data is not available.",
        },
      ],
    };
    expect(providerUsageUnusableReason(missingDb, "opencode")).toBeNull();
  });

  it("allows OpenCode Go with remaining budget and blocks only when Go windows are exhausted", () => {
    const remaining: UsageResponse = {
      providers: {
        opencode: {
          displayName: "OpenCode",
          plan: "Go",
          resources: {
            session: {
              kind: "consumption",
              unit: "USD",
              used: 1,
              limit: 12,
              utilization: 1 / 12,
            },
          },
        },
      },
    };
    expect(providerUsageUnusableReason(remaining, "opencode")).toBeNull();

    const exhausted: UsageResponse = {
      providers: {
        opencode: {
          displayName: "OpenCode",
          plan: "Go",
          resources: {
            session: {
              kind: "consumption",
              unit: "USD",
              used: 12,
              limit: 12,
              utilization: 1,
            },
            weekly: {
              kind: "consumption",
              unit: "USD",
              used: 30,
              limit: 30,
              utilization: 1,
            },
          },
        },
      },
    };
    expect(providerUsageUnusableReason(exhausted, "opencode")).toMatch(
      /^OpenCode Go usage limit reached\./,
    );

    const sessionOnly: UsageResponse = {
      providers: {
        opencode: {
          displayName: "OpenCode",
          plan: "Go",
          resources: {
            session: {
              kind: "consumption",
              unit: "USD",
              used: 12,
              limit: 12,
              utilization: 1,
            },
            weekly: {
              kind: "consumption",
              unit: "USD",
              used: 10,
              limit: 30,
              utilization: 10 / 30,
            },
          },
        },
      },
    };
    expect(providerUsageUnusableReason(sessionOnly, "opencode")).toMatch(
      /^OpenCode Go usage limit reached\./,
    );
  });
});
