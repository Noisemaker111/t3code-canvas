import { usageProviderIdForInstance } from "@t3tools/shared/providerFamily";

export type UsageResource = {
  kind?: "consumption" | "balance";
  unit?: string;
  used?: number;
  limit?: number;
  available?: number;
  utilization?: number;
  resetsAt?: string;
};

export type UsageProvider = {
  displayName?: string;
  plan?: string;
  fetchedAt?: string;
  stale?: boolean;
  resources?: Record<string, UsageResource>;
};

export type UsageResponse = {
  providers?: Record<string, UsageProvider>;
  errors?: Array<{ providerId?: string; code?: string; message?: string }>;
};

export type UsageEntry = UsageProvider & { id: string };

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  cursor: "Cursor",
  grok: "Grok",
  openrouter: "OpenRouter",
  opencode: "OpenCode",
};

/** Return a stable, human-friendly provider label for cards and error rows. */
export function formatProviderName(
  providerId: string | null | undefined,
  displayName?: string,
): string {
  const explicit = displayName?.trim();
  if (explicit) return explicit;
  const raw = providerId?.trim();
  if (!raw) return "Provider";
  const family = usageProviderIdForSelection(raw);
  const known = PROVIDER_DISPLAY_NAMES[family] ?? PROVIDER_DISPLAY_NAMES[raw.toLowerCase()];
  if (known) return known;
  return raw.replace(/[-_]+/gu, " ").replace(/\b\w/gu, (character) => character.toUpperCase());
}

const RESOURCE_ORDER: Record<string, number> = {
  session: 10,
  weekly: 20,
  weeklyOpus: 30,
  daily: 40,
  monthly: 50,
  totalUsage: 60,
  plan: 70,
  auto: 80,
  api: 90,
  credits: 100,
  balance: 110,
};

/** Keep windows readable across providers and keep list-price counters together at the end. */
export function sortUsageResources(
  entries: ReadonlyArray<readonly [string, UsageResource]>,
): Array<readonly [string, UsageResource]> {
  return [...entries].sort(([leftId, left], [rightId, right]) => {
    const leftRank = isListPriceUsd(left) ? 1_000 : (RESOURCE_ORDER[leftId] ?? 500);
    const rightRank = isListPriceUsd(right) ? 1_000 : (RESOURCE_ORDER[rightId] ?? 500);
    return (
      leftRank - rightRank ||
      formatResourceLabel(leftId).localeCompare(formatResourceLabel(rightId))
    );
  });
}

/** Map a composer/provider-instance id to the normalized usage-service id. */
export const usageProviderIdForSelection = usageProviderIdForInstance;

export function providerForSelection(
  providers: ReadonlyArray<UsageEntry>,
  selectedProviderId: string | null,
): UsageEntry | null {
  if (!selectedProviderId) return null;
  const family = usageProviderIdForSelection(selectedProviderId);
  return (
    providers.find((provider) => provider.id === selectedProviderId) ??
    providers.find((provider) => provider.id === family) ??
    null
  );
}

export function primaryResource(provider: UsageEntry | null): UsageResource | null {
  if (!provider?.resources) return null;
  const preferredIds = [
    "weekly",
    "plan",
    "session",
    "daily",
    "totalUsage",
    "monthly",
    "auto",
    "api",
    "credits",
    "balance",
  ];
  return (
    preferredIds.map((id) => provider.resources?.[id]).find(Boolean) ??
    Object.values(provider.resources)[0] ??
    null
  );
}

export function utilization(resource: UsageResource | null): number | null {
  if (!resource) return null;
  if (typeof resource.utilization === "number" && Number.isFinite(resource.utilization)) {
    return Math.max(0, Math.min(1, resource.utilization));
  }
  if (
    typeof resource.used === "number" &&
    Number.isFinite(resource.used) &&
    typeof resource.limit === "number" &&
    Number.isFinite(resource.limit) &&
    resource.limit > 0
  ) {
    return Math.max(0, Math.min(1, resource.used / resource.limit));
  }
  return null;
}

export function usageColor(value: number | null): string {
  if (value === null) return "#71717a";
  if (value >= 0.8) return "#ef4444";
  if (value >= 0.6) return "#eab308";
  return "#22c55e";
}

/**
 * Match server `providerFamilyUsable` in ModelRouting: any limited window at or
 * above this utilization hard-blocks new turns / Hermes skills / promptAssist.
 * (Previously the client required *every* window at 100%, so a spent Codex
 * session still looked usable while weekly had headroom — and Hermes kept
 * calling `codex exec` until OpenAI rejected it.)
 */
export const USAGE_HARD_BLOCK_UTILIZATION = 0.98;

function formatUsageResetHint(resetsAt: string | undefined): string {
  if (!resetsAt) return "";
  const resetMs = Date.parse(resetsAt);
  if (Number.isNaN(resetMs)) return "";
  try {
    return ` Resets ${new Date(resetMs).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })}.`;
  } catch {
    return "";
  }
}

/**
 * Why a provider family cannot accept new turns right now, derived from `/api/usage`.
 *
 * Returns `null` when usage is unknown (still loading / failed) or the family looks
 * usable — pickers fail open so a dead usage endpoint never bricks model selection.
 *
 * Hard blocks: unauthorized credentials, zero credit balance, any rate window at
 * ≥ {@link USAGE_HARD_BLOCK_UTILIZATION}. OpenCode is special: free models and
 * upstream keys (e.g. OpenRouter through the OpenCode harness) work without a Go
 * plan, and a missing local usage DB (`no_credentials`) only means spend tracking
 * is unavailable — not that the harness is unusable. Provider probe status
 * (installed/ready/auth) remains the primary gate for OpenCode. Cursor is special
 * the same way: its usage token and its run credential are separate stores.
 */
export function providerUsageUnusableReason(
  usage: UsageResponse | null | undefined,
  selectedProviderId: string,
): string | null {
  if (!usage) return null;

  const family = usageProviderIdForSelection(selectedProviderId);

  // OpenCode free + BYOK/upstream models do not require Go or local usage DBs.
  if (family === "opencode") {
    const unauthorized = (usage.errors ?? []).find(
      (error) => error.providerId === family && error.code === "unauthorized",
    );
    if (unauthorized) {
      return unauthorized.message?.trim() || "Provider authentication failed.";
    }
    const provider = usage.providers?.[family];
    if (!provider?.resources) return null;
    // Gate OpenCode only when Go-style limited windows exist; block on any spent one.
    for (const [, resource] of Object.entries(provider.resources)) {
      if (
        resource.kind !== "consumption" ||
        typeof resource.limit !== "number" ||
        resource.limit <= 0
      ) {
        continue;
      }
      const value = utilization(resource);
      if (value !== null && value >= USAGE_HARD_BLOCK_UTILIZATION) {
        return `OpenCode Go usage limit reached.${formatUsageResetHint(resource.resetsAt)}`;
      }
    }
    return null;
  }

  // Cursor keeps its usage token in the IDE's `state.vscdb` / the CLI's own config,
  // neither of which is the credential `cursor-agent` needs to run. A box where the
  // usage reader finds nothing but `cursor-agent about` says authenticated is normal,
  // so `no_credentials` there means "no usage numbers", not "cannot run".
  //
  // Claude is the same shape for skills / pickers: the usage poller reads
  // `~/.claude/.credentials.json` OAuth for Anthropic's usage API. That file can
  // be missing, expired, or unreadable on a headless box while the Claude CLI
  // probe still reports ready (or the owner routes skills off Claude). Blocking
  // Hermes auto-skills on `no_credentials` alone paused the board for "login"
  // when the real gate is install/authOk — fail open and let those decide.
  const blockOnMissingCredentials = family !== "cursor" && family !== "claude";
  const hardError = (usage.errors ?? []).find(
    (error) =>
      error.providerId === family &&
      (error.code === "unauthorized" ||
        (blockOnMissingCredentials && error.code === "no_credentials")),
  );
  if (hardError) {
    return hardError.message?.trim() || "Provider credentials are not available.";
  }

  const provider = usage.providers?.[family];
  if (!provider) return null;

  const resources = Object.entries(provider.resources ?? {});
  const balanceResources = resources
    .map(([, resource]) => resource)
    .filter((resource) => resource.kind === "balance");
  if (balanceResources.length > 0) {
    const hasCredits = balanceResources.some(
      (resource) => typeof resource.available === "number" && resource.available > 0,
    );
    if (!hasCredits) {
      return "No credits remaining.";
    }
  }

  for (const [, resource] of resources) {
    if (resource.kind === "balance") continue;
    const value = utilization(resource);
    if (value !== null && value >= USAGE_HARD_BLOCK_UTILIZATION) {
      return `Usage limit reached.${formatUsageResetHint(resource.resetsAt)}`;
    }
  }

  return null;
}

export function isProviderUsageUsable(
  usage: UsageResponse | null | undefined,
  selectedProviderId: string,
): boolean {
  return providerUsageUnusableReason(usage, selectedProviderId) === null;
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatResourceLabel(id: string): string {
  const knownLabels: Record<string, string> = {
    listToday: "List today",
    listWeek: "List 7d",
    weeklyOpus: "Weekly Opus",
    totalUsage: "Total usage",
    api: "API",
  };
  const known = knownLabels[id];
  if (known) return known;
  const label = id
    .replace(/([A-Z])/gu, " $1")
    .replace(/[-_]+/gu, " ")
    .trim();
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : "Usage";
}

/** A running spend counter (USD used with no limit), e.g. OpenRouter list price. */
export function isListPriceUsd(resource: UsageResource): boolean {
  return (
    resource.kind !== "balance" &&
    (resource.unit ?? "").toUpperCase() === "USD" &&
    typeof resource.used === "number" &&
    Number.isFinite(resource.used) &&
    resource.limit === undefined
  );
}

export function formatResourceValue(resource: UsageResource): string {
  if (resource.kind === "balance" && typeof resource.available === "number") {
    if ((resource.unit ?? "").toUpperCase() === "USD") {
      return `$${resource.available.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      })}`;
    }
    return `${resource.available.toLocaleString()} ${resource.unit ?? "available"}`;
  }
  if (isListPriceUsd(resource) && typeof resource.used === "number") {
    return `$${resource.used.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  if (typeof resource.used === "number" && typeof resource.limit === "number") {
    if (resource.unit === "percent") {
      return `${formatPercent(resource.used)}%`;
    }
    const unit = ` ${resource.unit ?? "used"}`;
    return `${resource.used.toLocaleString()} / ${resource.limit.toLocaleString()}${unit}`;
  }
  if (typeof resource.available === "number") {
    return `${resource.available.toLocaleString()} ${resource.unit ?? "available"}`;
  }
  return "No current value";
}

/**
 * Client-side burn-rate tracking, modeled after OpenUsage's blocks/burn-rate view. The
 * usage API only ever returns a live snapshot, so rate-of-change has to come from
 * comparing snapshots across polls — persisted to localStorage so it survives a refresh
 * of the page, not just of the dialog.
 */
export type UsageHistoryPoint = {
  readonly value: number;
  readonly timestampMs: number;
};
export type UsageHistoryStore = Record<string, ReadonlyArray<UsageHistoryPoint>>;

export const USAGE_HISTORY_STORAGE_KEY = "t3.usageHistory.v1";
const HISTORY_MAX_POINTS = 50;
const HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function historyKey(providerId: string, resourceId: string): string {
  return `${providerId}:${resourceId}`;
}

export function readUsageHistory(storage: Pick<Storage, "getItem"> | null): UsageHistoryStore {
  if (!storage) return {};
  try {
    const raw = storage.getItem(USAGE_HISTORY_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as UsageHistoryStore) : {};
  } catch {
    return {};
  }
}

/** Appends a point for every numeric `used` (or `available`, for balance resources) value in
 * `providers`, prunes stale/overflow points, persists, and returns the updated store. */
export function recordUsageSnapshot(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  providers: ReadonlyArray<UsageEntry>,
  nowMs: number,
): UsageHistoryStore {
  const store = readUsageHistory(storage);
  const next: UsageHistoryStore = { ...store };
  const cutoff = nowMs - HISTORY_MAX_AGE_MS;
  for (const provider of providers) {
    for (const [resourceId, resource] of Object.entries(provider.resources ?? {})) {
      const value = resource.used ?? resource.available;
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const key = historyKey(provider.id, resourceId);
      next[key] = [...(store[key] ?? []), { value, timestampMs: nowMs }]
        .filter((point) => point.timestampMs >= cutoff)
        .slice(-HISTORY_MAX_POINTS);
    }
  }
  if (storage) {
    try {
      storage.setItem(USAGE_HISTORY_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage full/unavailable (private browsing): burn rate just won't have history next poll.
    }
  }
  return next;
}

/** Rate of consumption per hour for a consumption resource, from the oldest to newest history
 * point on file. Null until at least two snapshots exist, or the value isn't trending up
 * (e.g. it just reset). Balance resources (credits available) aren't rated here — see
 * `burnRatePerHour` callers, which pass the resource's `kind`. */
export function burnRatePerHour(
  history: UsageHistoryStore,
  providerId: string,
  resourceId: string,
  resourceKind: UsageResource["kind"],
): number | null {
  if (resourceKind === "balance") return null;
  const points = history[historyKey(providerId, resourceId)];
  if (!points || points.length < 2) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const elapsedHours = (last.timestampMs - first.timestampMs) / 3_600_000;
  if (elapsedHours <= 0) return null;
  const delta = last.value - first.value;
  return delta > 0 ? delta / elapsedHours : null;
}

export function hoursUntilReset(resetsAt: string | undefined, nowMs: number): number | null {
  if (!resetsAt) return null;
  const target = Date.parse(resetsAt);
  if (Number.isNaN(target)) return null;
  const hours = (target - nowMs) / 3_600_000;
  return hours > 0 ? hours : null;
}

/** Hours until a consumption resource's `used` reaches its `limit` at the given rate, or null
 * if there's no positive rate or no limit to hit. */
export function hoursUntilExhausted(
  resource: UsageResource,
  ratePerHour: number | null,
): number | null {
  if (!ratePerHour || ratePerHour <= 0) return null;
  if (typeof resource.used !== "number" || typeof resource.limit !== "number") return null;
  const remaining = resource.limit - resource.used;
  return remaining > 0 ? remaining / ratePerHour : null;
}

export function formatHours(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}
