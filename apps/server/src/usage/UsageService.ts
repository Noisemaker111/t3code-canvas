import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  listCostResources,
  sumClaudeListCost,
  sumCodexListCost,
  type ListCostTotals,
} from "./listCost.ts";

export type UsageResource = {
  readonly kind: "consumption" | "balance";
  readonly unit: string;
  readonly used?: number;
  readonly limit?: number;
  readonly available?: number;
  readonly utilization?: number | undefined;
  readonly resetsAt?: string | undefined;
};

export type UsageProvider = {
  readonly displayName: string;
  readonly plan?: string;
  readonly fetchedAt: string;
  readonly stale?: boolean;
  readonly resources: Record<string, UsageResource>;
};

export type UsageError = {
  readonly providerId?: UsageProviderId;
  readonly code: "no_credentials" | "unauthorized" | "timeout" | "unavailable" | "invalid_response";
  readonly message: string;
};

export type UsageResponse = {
  readonly providers: Record<string, UsageProvider>;
  readonly errors: ReadonlyArray<UsageError>;
  readonly fetchedAt: string;
};

export type UsageProviderId = "codex" | "claude" | "grok" | "openrouter" | "opencode" | "cursor";

/** Families whose credential is a plain key the operator can paste in. */
export const STORED_CREDENTIAL_PROVIDERS = ["cursor", "grok", "openrouter"] as const;
export type StoredCredentialProvider = (typeof STORED_CREDENTIAL_PROVIDERS)[number];

export function isStoredCredentialProvider(value: string): value is StoredCredentialProvider {
  return (STORED_CREDENTIAL_PROVIDERS as ReadonlyArray<string>).includes(value);
}

/**
 * The one on-disk store for keys pasted into Settings → Connections → API keys.
 *
 * Everything that needs one reads it from here — the usage readers below, the
 * OpenRouter model catalog behind Hermes and the model bench, and the OpenCode
 * driver's spawn environment — so a key is entered once, not once per consumer.
 */
export type StoredCredentialsIo = {
  readonly homeDir?: string;
  readonly readFile?: (path: string) => Promise<string>;
  readonly writeFile?: (path: string, contents: string) => Promise<void>;
};

const defaultReadFile = (path: string): Promise<string> => NodeFSP.readFile(path, "utf8");
const defaultWriteFile = (path: string, contents: string): Promise<void> =>
  NodeFSP.writeFile(path, contents, "utf8");

export function storedCredentialsPath(homeDir: string = NodeOS.homedir()): string {
  return NodePath.join(homeDir, ".t3code", "usage-credentials.json");
}

export async function readStoredCredentials(
  io: StoredCredentialsIo = {},
): Promise<Record<string, string>> {
  const readFile = io.readFile ?? defaultReadFile;
  try {
    const parsed = object(JSON.parse(await readFile(storedCredentialsPath(io.homeDir)))) ?? {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const token = string(value);
      if (token) out[key] = token;
    }
    return out;
  } catch {
    // No store yet (or an unreadable one) means no pasted key; every caller
    // reports "credential not found" rather than substituting another source.
    return {};
  }
}

export async function readStoredCredential(
  provider: StoredCredentialProvider,
  io: StoredCredentialsIo = {},
): Promise<string | undefined> {
  return (await readStoredCredentials(io))[provider];
}

/**
 * One candidate credential for a family.
 *
 * `label` is what `/api/usage/credentials` reports — an env var name, a file
 * path, or a description of a CLI login. It never carries the secret.
 *
 * `presenceOnly` marks a source that proves a login exists but yields no key a
 * caller could send anywhere (OpenCode's auth store, whose usage is read from
 * its SQLite databases). Status reporting counts it; key resolution skips it.
 */
export type ProviderCredentialSource = {
  readonly label: string;
  readonly read: () => Promise<string | undefined>;
  readonly presenceOnly?: boolean;
};

export type ProviderCredentialContext = {
  readonly homeDir: string;
  readonly env: Record<string, string | undefined>;
  readonly readFile: (path: string) => Promise<string>;
  readonly readCursorAccessToken?: () => Promise<string | undefined>;
};

/**
 * How one family's key is found, and the env var an agent process expects it
 * under. Declaring the chain here — rather than per consumer — is what keeps
 * the usage reader, the model catalogs, the health probe, and the driver spawn
 * environment agreeing on where a key comes from.
 */
export type ProviderCredentialSpec = {
  /** Env var a spawned CLI reads this key from; absent when the CLI owns its own login. */
  readonly envVar?: string;
  /** Whether the operator can paste this one in (Settings → Connections → API keys). */
  readonly writable: boolean;
  readonly sources: (context: ProviderCredentialContext) => ReadonlyArray<ProviderCredentialSource>;
};

const envSource = (context: ProviderCredentialContext, name: string): ProviderCredentialSource => ({
  label: `env:${name}`,
  read: async () => string(context.env[name]),
});

const storedSource = (
  context: ProviderCredentialContext,
  provider: StoredCredentialProvider,
): ProviderCredentialSource => ({
  label: "stored token",
  read: () =>
    readStoredCredential(provider, { homeDir: context.homeDir, readFile: context.readFile }),
});

const jsonFileSource = (
  context: ProviderCredentialContext,
  path: string,
  pick: (data: Record<string, unknown>) => string | undefined,
  options: { readonly presenceOnly?: boolean } = {},
): ProviderCredentialSource => ({
  label: path,
  ...(options.presenceOnly ? { presenceOnly: true } : {}),
  read: async () => {
    try {
      return pick(object(JSON.parse(await context.readFile(path))) ?? {});
    } catch {
      // An unreadable or absent file is simply not this family's source; the
      // walk moves on and reports "not found" if nothing else answers.
      return undefined;
    }
  },
});

const openCodeDataDirFor = (context: ProviderCredentialContext): string => {
  const explicit = string(context.env.OPENCODE_DATA_DIR);
  if (explicit) return explicit;
  const xdgDataHome = string(context.env.XDG_DATA_HOME);
  return xdgDataHome
    ? NodePath.join(xdgDataHome, "opencode")
    : NodePath.join(context.homeDir, ".local", "share", "opencode");
};

const openRouterKeyIn = (data: Record<string, unknown>): string | undefined => {
  const entry = object(data.openrouter);
  return string(entry?.key) ?? string(entry?.apiKey) ?? string(data.apiKey);
};

/** The credential chain per family, in the precedence every consumer follows. */
export const PROVIDER_CREDENTIALS: Record<UsageProviderId, ProviderCredentialSpec> = {
  codex: {
    writable: false,
    sources: (context) => [
      jsonFileSource(context, NodePath.join(context.homeDir, ".codex", "auth.json"), (data) =>
        string((object(data.tokens) ?? {}).access_token),
      ),
      jsonFileSource(
        context,
        NodePath.join(context.homeDir, ".config", "codex", "auth.json"),
        (data) => string((object(data.tokens) ?? {}).access_token),
      ),
    ],
  },
  claude: {
    writable: false,
    sources: (context) => [
      jsonFileSource(
        context,
        NodePath.join(context.homeDir, ".claude", ".credentials.json"),
        (data) => string((object(data.claudeAiOauth) ?? {}).accessToken),
      ),
    ],
  },
  grok: {
    envVar: "XAI_API_KEY",
    writable: true,
    sources: (context) => [
      jsonFileSource(
        context,
        NodePath.join(context.homeDir, ".grok", "auth.json"),
        (data) =>
          string(
            Object.values(data)
              .map(object)
              .find((entry) => string(entry?.key))?.key,
          ),
        // The CLI login authenticates cli-chat-proxy, not api.x.ai — it proves
        // Grok usage is readable but is not an XAI_API_KEY.
        { presenceOnly: true },
      ),
      envSource(context, "XAI_API_KEY"),
      storedSource(context, "grok"),
    ],
  },
  openrouter: {
    envVar: "OPENROUTER_API_KEY",
    writable: true,
    sources: (context) => [
      envSource(context, "OPENROUTER_API_KEY"),
      storedSource(context, "openrouter"),
      jsonFileSource(
        context,
        NodePath.join(openCodeDataDirFor(context), "auth.json"),
        openRouterKeyIn,
      ),
      jsonFileSource(
        context,
        NodePath.join(context.homeDir, ".config", "openusage", "openrouter.json"),
        openRouterKeyIn,
      ),
    ],
  },
  opencode: {
    writable: false,
    sources: (context) => [
      jsonFileSource(
        context,
        NodePath.join(openCodeDataDirFor(context), "auth.json"),
        () => "present",
        { presenceOnly: true },
      ),
    ],
  },
  cursor: {
    envVar: "CURSOR_ACCESS_TOKEN",
    writable: true,
    sources: (context) => [
      envSource(context, "CURSOR_ACCESS_TOKEN"),
      envSource(context, "T3CODE_CURSOR_ACCESS_TOKEN"),
      storedSource(context, "cursor"),
      {
        label: "Cursor IDE/CLI login",
        read: () =>
          (
            context.readCursorAccessToken ??
            (() => readCursorAccessToken(context.homeDir, context.env, context.readFile))
          )(),
      },
    ],
  },
};

export const USAGE_PROVIDER_IDS = Object.keys(
  PROVIDER_CREDENTIALS,
) as ReadonlyArray<UsageProviderId>;

const defaultCredentialContext = (
  overrides: Partial<ProviderCredentialContext> = {},
): ProviderCredentialContext => ({
  homeDir: NodeOS.homedir(),
  env: process.env,
  readFile: (path) => NodeFSP.readFile(path, "utf8"),
  ...overrides,
});

/**
 * Walk a family's chain and return the first credential it yields, with the
 * label of the source that answered. `undefined` means no source has one.
 *
 * This is the only key lookup in the server: usage fetchers, the OpenRouter
 * catalog behind Hermes and the bench, the health probe, and driver spawn
 * environments all resolve through it, so none of them can disagree about
 * precedence or silently read a source the others do not know about.
 */
export async function resolveProviderCredential(
  family: UsageProviderId,
  overrides: Partial<ProviderCredentialContext> = {},
): Promise<{ readonly key: string; readonly source: string } | undefined> {
  const context = defaultCredentialContext(overrides);
  for (const source of PROVIDER_CREDENTIALS[family].sources(context)) {
    if (source.presenceOnly) continue;
    const key = await source.read();
    if (key) return { key, source: source.label };
  }
  return undefined;
}

/** The credential itself, for callers that only need to authenticate a request. */
export async function resolveProviderKey(
  family: UsageProviderId,
  overrides: Partial<ProviderCredentialContext> = {},
): Promise<string | undefined> {
  return (await resolveProviderCredential(family, overrides))?.key;
}

/**
 * Which source answers for a family right now, including presence-only ones.
 * Labels only — the secret never crosses this boundary.
 */
export async function resolveProviderCredentialSource(
  family: UsageProviderId,
  overrides: Partial<ProviderCredentialContext> = {},
): Promise<string | null> {
  const context = defaultCredentialContext(overrides);
  for (const source of PROVIDER_CREDENTIALS[family].sources(context)) {
    if (await source.read()) return source.label;
  }
  return null;
}

/** Persist (or clear, with `null`) a pasted key for a family. */
export async function writeStoredCredential(
  provider: StoredCredentialProvider,
  token: string | null,
  io: StoredCredentialsIo = {},
): Promise<void> {
  const writeFile = io.writeFile ?? defaultWriteFile;
  const current = await readStoredCredentials(io);
  const next = token?.trim();
  if (next) {
    current[provider] = next;
  } else {
    delete current[provider];
  }
  const path = storedCredentialsPath(io.homeDir);
  const contents = `${JSON.stringify(current, null, 2)}\n`;
  try {
    await writeFile(path, contents);
  } catch {
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
}

/**
 * Where the usage reader found (or failed to find) a family's credential.
 * `source` is a human-readable label (env var name, file path, "stored token"),
 * never the secret itself. `writable` marks families whose token can be set
 * through {@link UsageService.setStoredCredential}.
 */
export type UsageCredentialStatus = {
  readonly providerId: UsageProviderId;
  readonly source: string | null;
  readonly writable: boolean;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Clock = () => Date;

export type UsageServiceOptions = {
  readonly homeDir?: string;
  readonly fetch?: FetchLike;
  readonly now?: Clock;
  readonly cacheTtlMs?: number;
  readonly timeoutMs?: number;
  /** Hard ceiling on how long an HTTP request may wait for usage before getting a bounded answer. */
  readonly responseDeadlineMs?: number;
  /** Age after which a still-unsettled refresh is presumed wedged and abandoned for a fresh one. */
  readonly staleInFlightMs?: number;
  readonly readFile?: (path: string) => Promise<string>;
  readonly writeFile?: (path: string, contents: string) => Promise<void>;
  readonly readDir?: (path: string) => Promise<ReadonlyArray<string>>;
  readonly env?: Record<string, string | undefined>;
  readonly openCodeSpend?: (dbPath: string, sinceMs: number) => Promise<number>;
  /** Override Cursor state.vscdb token lookup (tests). */
  readonly readCursorAccessToken?: () => Promise<string | undefined>;
  /** Override Claude local JSONL list-price scan (tests). */
  readonly sumClaudeListCost?: (input: {
    readonly homeDir: string;
    readonly nowMs: number;
  }) => Promise<ListCostTotals | null>;
  /** Override Codex local JSONL list-price scan (tests). */
  readonly sumCodexListCost?: (input: {
    readonly homeDir: string;
    readonly nowMs: number;
  }) => Promise<ListCostTotals | null>;
};

const PROVIDERS: ReadonlyArray<UsageProviderId> = [
  "codex",
  "claude",
  "grok",
  "openrouter",
  "opencode",
  "cursor",
];
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 8_000;
// The browser gives up an attempt at ~12s; answering just under that keeps the panel showing a
// concrete "still refreshing" payload instead of a client-side timeout.
const DEFAULT_RESPONSE_DEADLINE_MS = 10_000;
// Beyond any legitimate worst case (token refresh across 3 endpoints + retried usage request).
const DEFAULT_STALE_IN_FLIGHT_MS = 90_000;

export function clampUtilization(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

export function normalizePercentageResource(input: {
  usedPercent?: unknown;
  resetsAt?: unknown;
}): UsageResource | null {
  const percent = number(input.usedPercent);
  if (percent === undefined) return null;
  return {
    kind: "consumption",
    unit: "percent",
    used: percent,
    limit: 100,
    utilization: clampUtilization(percent / 100),
    ...(isoDate(input.resetsAt) ? { resetsAt: isoDate(input.resetsAt) } : {}),
  };
}

export function activeProviderMatchesUsage(
  activeProviderId: string | null | undefined,
  usageProviderId: string,
): boolean {
  if (!activeProviderId) return false;
  const normalized = activeProviderId.toLowerCase();
  return (
    normalized === usageProviderId ||
    normalized.startsWith(`${usageProviderId}_`) ||
    normalized.startsWith(`${usageProviderId}-`)
  );
}

/** Process-wide default so /api/usage and Hermes/routing share one cache. */
let defaultUsageService: UsageService | null = null;

export function getUsageService(): UsageService {
  if (!defaultUsageService) {
    defaultUsageService = new UsageService();
  }
  return defaultUsageService;
}

export class UsageService {
  private readonly homeDir: string;
  private readonly fetch: FetchLike;
  private readonly now: Clock;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly readFile: (path: string) => Promise<string>;
  private readonly writeFile: (path: string, contents: string) => Promise<void>;
  private readonly readDir: (path: string) => Promise<ReadonlyArray<string>>;
  private readonly env: Record<string, string | undefined>;
  private readonly openCodeSpend: (dbPath: string, sinceMs: number) => Promise<number>;
  private readonly readCursorAccessToken: () => Promise<string | undefined>;
  private readonly sumClaudeListCost: (input: {
    readonly homeDir: string;
    readonly nowMs: number;
  }) => Promise<ListCostTotals | null>;
  private readonly sumCodexListCost: (input: {
    readonly homeDir: string;
    readonly nowMs: number;
  }) => Promise<ListCostTotals | null>;
  private readonly responseDeadlineMs: number;
  private readonly staleInFlightMs: number;
  private cache: UsageResponse | undefined;
  private inFlight: Promise<UsageResponse> | undefined;
  private inFlightStartedMs = 0;
  /** Utilization snapshots per `provider:resource`, for burn-rate over this process's lifetime. */
  private readonly burnHistory = new Map<
    string,
    Array<{ readonly atMs: number; readonly utilization: number }>
  >();

  constructor(options: UsageServiceOptions = {}) {
    this.homeDir = options.homeDir ?? NodeOS.homedir();
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.responseDeadlineMs = options.responseDeadlineMs ?? DEFAULT_RESPONSE_DEADLINE_MS;
    this.staleInFlightMs = options.staleInFlightMs ?? DEFAULT_STALE_IN_FLIGHT_MS;
    this.readFile = options.readFile ?? ((path) => NodeFSP.readFile(path, "utf8"));
    // Refreshed CLI tokens are written back atomically (temp file + rename) so a crash mid-write can
    // never leave the provider CLI with a truncated credentials file.
    this.writeFile =
      options.writeFile ??
      (async (path, contents) => {
        const tmp = `${path}.t3usage.${process.pid}.tmp`;
        await NodeFSP.writeFile(tmp, contents, { mode: 0o600 });
        await NodeFSP.rename(tmp, path);
      });
    this.readDir = options.readDir ?? ((path) => NodeFSP.readdir(path));
    this.env = options.env ?? process.env;
    this.openCodeSpend = options.openCodeSpend ?? readOpenCodeSpend;
    this.readCursorAccessToken =
      options.readCursorAccessToken ??
      (() => readCursorAccessToken(this.homeDir, this.env, this.readFile));
    this.sumClaudeListCost = options.sumClaudeListCost ?? sumClaudeListCost;
    this.sumCodexListCost = options.sumCodexListCost ?? sumCodexListCost;
  }

  // Guaranteed-resolving wrapper for HTTP handlers: a rejected promise inside an Effect route
  // becomes a defect that kills the fiber before a response is written, which the Cloudflare
  // tunnel surfaces to the browser as an opaque 502. It is also guaranteed-BOUNDED: without a
  // deadline, one refresh that never settles would make this route — and, via the shared
  // in-flight promise, every future request from every client — hang forever, which the panel
  // shows as an eternal "Refreshing…" with no error.
  async getUsageSafe(options: { readonly force?: boolean } = {}): Promise<UsageResponse> {
    try {
      return await this.withDeadline(this.getUsage(options));
    } catch {
      return {
        providers: {},
        errors: [{ code: "unavailable", message: "Usage is temporarily unavailable." }],
        fetchedAt: this.now().toISOString(),
      };
    }
  }

  private withDeadline(work: Promise<UsageResponse>): Promise<UsageResponse> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          providers: Object.fromEntries(
            Object.entries(this.cache?.providers ?? {}).map(([id, provider]) => [
              id,
              { ...provider, stale: true },
            ]),
          ),
          errors: [
            {
              code: "timeout",
              message:
                "Usage refresh is taking longer than expected. Showing last known data; the next refresh will retry.",
            },
          ],
          fetchedAt: this.now().toISOString(),
        });
      }, this.responseDeadlineMs);
      // Don't let a pending usage deadline keep the process alive during shutdown.
      timer.unref?.();
      work.then(
        (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        () => {
          clearTimeout(timer);
          resolve({
            providers: {},
            errors: [{ code: "unavailable", message: "Usage is temporarily unavailable." }],
            fetchedAt: this.now().toISOString(),
          });
        },
      );
    });
  }

  async getUsage(options: { readonly force?: boolean } = {}): Promise<UsageResponse> {
    const now = this.now();
    if (
      !options.force &&
      this.cache &&
      now.getTime() - Date.parse(this.cache.fetchedAt) < this.cacheTtlMs
    )
      return this.cache;
    // A refresh that has been pending far beyond every internal timeout is wedged (e.g. a fetch
    // implementation that ignored its abort signal). Abandon it so new requests get a fresh
    // attempt instead of awaiting a dead promise forever; its guarded finally() below can no
    // longer clobber the replacement.
    if (this.inFlight && now.getTime() - this.inFlightStartedMs > this.staleInFlightMs) {
      this.inFlight = undefined;
    }
    if (!this.inFlight) {
      this.inFlightStartedMs = now.getTime();
      const pending: Promise<UsageResponse> = this.refresh().finally(() => {
        if (this.inFlight === pending) this.inFlight = undefined;
      });
      this.inFlight = pending;
    }
    return this.inFlight;
  }

  private async refresh(): Promise<UsageResponse> {
    try {
      const results = await Promise.all(
        PROVIDERS.map((providerId) => this.fetchProvider(providerId)),
      );
      const providers: Record<string, UsageProvider> = {};
      const errors: UsageError[] = [];
      for (const result of results) {
        if (result.provider) providers[result.id] = result.provider;
        if (result.error) errors.push(result.error);
        const cached = this.cache?.providers[result.id];
        if (!result.provider && cached) {
          providers[result.id] = { ...cached, stale: true };
        }
      }
      const response: UsageResponse = { providers, errors, fetchedAt: this.now().toISOString() };
      if (Object.keys(providers).length > 0) this.cache = response;
      this.recordBurnHistory(response);
      return response;
    } catch {
      // Never reject: a rejected refresh becomes an Effect defect in the /api/usage route, which
      // kills the fiber before a response is written and surfaces to the browser as a gateway 502.
      return {
        providers: Object.fromEntries(
          Object.entries(this.cache?.providers ?? {}).map(([id, provider]) => [
            id,
            { ...provider, stale: true },
          ]),
        ),
        errors: [{ code: "unavailable", message: "Usage is temporarily unavailable." }],
        fetchedAt: this.now().toISOString(),
      };
    }
  }

  /**
   * Append one utilization point per consumption window on every real refresh.
   * A drop between points is a window reset — history restarts there, so the
   * rate never averages across a reset boundary.
   */
  private recordBurnHistory(response: UsageResponse): void {
    const atMs = Date.parse(response.fetchedAt);
    if (!Number.isFinite(atMs)) return;
    for (const [providerId, provider] of Object.entries(response.providers)) {
      if (provider.stale) continue;
      for (const [resourceId, resource] of Object.entries(provider.resources)) {
        if (resource.kind !== "consumption") continue;
        const utilization = resource.utilization;
        if (typeof utilization !== "number" || !Number.isFinite(utilization)) continue;
        const key = `${providerId}:${resourceId}`;
        const points = this.burnHistory.get(key) ?? [];
        const last = points[points.length - 1];
        const next =
          last && utilization < last.utilization
            ? [{ atMs, utilization }]
            : [...points, { atMs, utilization }];
        this.burnHistory.set(key, next.slice(-50));
      }
    }
  }

  /**
   * Observed utilization burn per hour for one window, from this process's own
   * snapshots. Null until two points exist or while the window is flat.
   */
  burnRatePerHour(providerId: string, resourceId: string): number | null {
    const points = this.burnHistory.get(`${providerId}:${resourceId}`);
    if (!points || points.length < 2) return null;
    const first = points[0] as { atMs: number; utilization: number };
    const last = points[points.length - 1] as { atMs: number; utilization: number };
    const elapsedHours = (last.atMs - first.atMs) / 3_600_000;
    if (elapsedHours <= 0) return null;
    const delta = last.utilization - first.utilization;
    return delta > 0 ? delta / elapsedHours : null;
  }

  private async fetchProvider(
    id: UsageProviderId,
  ): Promise<{ id: UsageProviderId; provider?: UsageProvider; error?: UsageError }> {
    try {
      return { id, provider: await this.fetchById(id) };
    } catch (cause) {
      return { id, error: usageError(id, cause) };
    }
  }

  private fetchById(id: UsageProviderId): Promise<UsageProvider> {
    switch (id) {
      case "codex":
        return this.fetchCodex();
      case "claude":
        return this.fetchClaude();
      case "grok":
        return this.fetchGrok();
      case "openrouter":
        return this.fetchOpenRouter();
      case "opencode":
        return this.fetchOpenCode();
      case "cursor":
        return this.fetchCursor();
    }
  }

  private async fetchCodex(): Promise<UsageProvider> {
    const { path, data: auth } = await this.readJsonFirst([
      NodePath.join(this.homeDir, ".codex", "auth.json"),
      NodePath.join(this.homeDir, ".config", "codex", "auth.json"),
    ]);
    const tokens = object(auth.tokens) ?? {};
    let token = string(tokens.access_token);
    if (!token) throw new UsageFailure("no_credentials", "Codex CLI login is not available.");
    const refreshToken = string(tokens.refresh_token);
    const refresh = refreshToken
      ? () => this.refreshCodexToken(refreshToken, path, auth, tokens)
      : undefined;
    // Proactively refresh when the access-token JWT has expired so a headless server never sits on a
    // stale token between CLI sessions.
    if (refresh && this.isExpired(jwtExpMs(token))) token = (await refresh()) ?? token;
    const accountId = string(tokens.account_id);
    const headers = (bearer: string): Record<string, string> => ({
      Authorization: `Bearer ${bearer}`,
      Accept: "application/json",
      ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
    });
    const body = await this.getJsonWithRefresh(
      "https://chatgpt.com/backend-api/wham/usage",
      token,
      headers,
      refresh,
    );
    const rateLimit = object(body.rate_limit);
    const resources: Record<string, UsageResource> = {};
    // Codex Plus/Pro is weekly-capped now. Prefer secondary_window; fall back to primary when
    // that is the only window the API returns (still label it weekly for the panel).
    if (rateLimit?.secondary_window) {
      addPercent(resources, "weekly", rateLimit.secondary_window);
    } else {
      addPercent(resources, "weekly", rateLimit?.primary_window);
    }
    Object.assign(
      resources,
      listCostResources(
        await this.sumCodexListCost({
          homeDir: this.homeDir,
          nowMs: this.now().getTime(),
        }).catch(() => null),
      ),
    );
    return this.provider("Codex", string(body.plan_type), resources);
  }

  private async fetchClaude(): Promise<UsageProvider> {
    const { path, data: auth } = await this.readJsonFirst([
      NodePath.join(this.homeDir, ".claude", ".credentials.json"),
    ]);
    const oauth = object(auth.claudeAiOauth) ?? {};
    let token = string(oauth.accessToken);
    if (!token) throw new UsageFailure("no_credentials", "Claude CLI login is not available.");
    const refreshToken = string(oauth.refreshToken);
    const refresh = refreshToken
      ? () => this.refreshClaudeToken(refreshToken, path, auth, oauth)
      : undefined;
    // The Claude OAuth access token lives ~8-24h; on a headless VPS it is usually stale by the time the
    // usage panel polls, so refresh it up front when `expiresAt` says it has lapsed.
    if (refresh && this.isExpired(number(oauth.expiresAt))) token = (await refresh()) ?? token;
    const base =
      process.env.CLAUDE_LOCAL_OAUTH_API_BASE ??
      process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL ??
      "https://api.anthropic.com";
    const body = await this.getJsonWithRefresh(
      `${base.replace(/\/$/u, "")}/api/oauth/usage`,
      token,
      claudeHeaders,
      refresh,
    );
    const resources: Record<string, UsageResource> = {};
    addPercent(resources, "session", body.five_hour);
    addPercent(resources, "weekly", body.seven_day);
    // Max plans meter the top-tier models in their own weekly bucket; absent
    // on plans that don't split, in which case addPercent quietly skips it.
    addPercent(resources, "weeklyOpus", body.seven_day_opus);
    Object.assign(
      resources,
      listCostResources(
        await this.sumClaudeListCost({
          homeDir: this.homeDir,
          nowMs: this.now().getTime(),
        }).catch(() => null),
      ),
    );
    return this.provider("Claude", string(oauth.subscriptionType), resources);
  }

  private async fetchGrok(): Promise<UsageProvider> {
    const resources: Record<string, UsageResource> = {};
    let plan: string | undefined;

    try {
      const { data: auth } = await this.readJsonFirst([
        NodePath.join(this.homeDir, ".grok", "auth.json"),
      ]);
      const candidate = Object.values(auth)
        .map(object)
        .find((entry) => string(entry?.key));
      const token = string(candidate?.key);
      if (!token) throw new UsageFailure("no_credentials", "Grok CLI login is not available.");
      const [credits, settings] = await Promise.all([
        this.getJson(
          "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
          grokHeaders(token),
        ),
        this.getJson("https://cli-chat-proxy.grok.com/v1/settings", grokHeaders(token)).catch(
          (): Record<string, unknown> => ({}),
        ),
      ]);
      // SuperGrok window — always surface percent when present (not only period_type=weekly).
      addPercent(resources, "weekly", credits);
      const remaining =
        number(credits.remaining) ??
        number(credits.remaining_credits) ??
        number(credits.credits_remaining);
      if (remaining !== undefined) {
        resources.balance = {
          kind: "balance",
          unit: string(credits.unit) ?? "credits",
          available: remaining,
        };
      }
      plan = string(settings.subscription_tier_display) ?? string(settings.subscription_tier);
    } catch (cause) {
      // Fall through to XAI API key credits when CLI auth is missing.
      if (!(cause instanceof UsageFailure) || cause.code !== "no_credentials") throw cause;
    }

    const xaiKey = await resolveProviderKey("grok", this.credentialContext());
    if (xaiKey) {
      try {
        const keyInfo = await this.getJson("https://api.x.ai/v1/api-key", {
          Authorization: `Bearer ${xaiKey}`,
          Accept: "application/json",
        });
        const remaining = number(keyInfo.remaining_balance);
        const spent = number(keyInfo.spent_balance);
        const granted = number(keyInfo.total_granted);
        if (remaining !== undefined && resources.balance === undefined) {
          resources.balance = {
            kind: "balance",
            unit: "USD",
            available: remaining,
            ...(spent !== undefined ? { used: spent } : {}),
            ...(granted !== undefined && granted > 0 ? { limit: granted } : {}),
          };
        }
      } catch {
        /* optional supplement */
      }
    }

    if (Object.keys(resources).length === 0) {
      throw new UsageFailure("no_credentials", "Grok CLI login is not available.");
    }
    return this.provider("Grok", plan, resources);
  }

  private async fetchOpenRouter(): Promise<UsageProvider> {
    const key = await resolveProviderKey("openrouter", this.credentialContext());
    if (!key) throw new UsageFailure("no_credentials", "OpenRouter API key is not available.");
    const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    const credits =
      object((await this.getJson("https://openrouter.ai/api/v1/credits", headers)).data) ?? {};
    // Per-key info is best-effort: the credit balance alone is still worth rendering.
    const keyInfo = object(
      (
        await this.getJson("https://openrouter.ai/api/v1/key", headers).catch(
          (): Record<string, unknown> => ({}),
        )
      ).data,
    );
    const resources: Record<string, UsageResource> = {};
    const total = number(credits.total_credits);
    const used = number(credits.total_usage);
    if (total !== undefined && used !== undefined) {
      // Credits are a cash balance — no utilization bar in the panel.
      resources.balance = {
        kind: "balance",
        unit: "USD",
        available: round2(Math.max(0, total - used)),
        ...(total > 0 ? { used: round2(used), limit: round2(total) } : {}),
      };
    }
    const keyLimit = number(keyInfo?.limit);
    const keyUsage = number(keyInfo?.usage);
    if (keyLimit !== undefined && keyLimit > 0 && keyUsage !== undefined) {
      resources.credits = {
        kind: "consumption",
        unit: "USD",
        used: round2(keyUsage),
        limit: round2(keyLimit),
        utilization: clampUtilization(keyUsage / keyLimit),
      };
    }
    return this.provider(
      "OpenRouter",
      keyInfo?.is_free_tier === true ? "Free tier" : undefined,
      resources,
    );
  }

  // OpenCode Go: sum local SQLite spend vs published caps. Zen: credit balance when a
  // console session cookie is available (OPENCODE_AUTH_COOKIE / T3CODE_OPENCODE_AUTH_COOKIE).
  private async fetchOpenCode(): Promise<UsageProvider> {
    const resources: Record<string, UsageResource> = {};
    let plan: string | undefined;
    let hasAny = false;

    const zenBalance = await this.fetchOpenCodeZenBalance().catch(() => undefined);
    if (zenBalance !== undefined) {
      resources.balance = {
        kind: "balance",
        unit: "USD",
        available: zenBalance,
      };
      plan = "Zen";
      hasAny = true;
    }

    try {
      const dataDir = this.openCodeDataDir();
      const entries = await this.readDir(dataDir).catch(() => {
        throw new UsageFailure("no_credentials", "OpenCode CLI data is not available.");
      });
      const dbPaths = entries
        .filter((name) => /^opencode.*\.db$/u.test(name))
        .map((name) => NodePath.join(dataDir, name));
      if (dbPaths.length === 0)
        throw new UsageFailure("no_credentials", "OpenCode CLI data is not available.");
      const auth = await this.readJsonFirst([NodePath.join(dataDir, "auth.json")]).catch(
        () => undefined,
      );
      const hasGoPlan = object(auth?.data.opencode) !== undefined;
      const nowMs = this.now().getTime();
      const weekStart = startOfUtcWeek(nowMs);
      const monthStart = startOfUtcMonth(nowMs);
      const windows = [
        { key: "session", sinceMs: nowMs - 5 * 3_600_000, limit: 12 },
        { key: "weekly", sinceMs: weekStart, limit: 30, resetsAt: weekStart + 7 * 86_400_000 },
        { key: "monthly", sinceMs: monthStart, limit: 60, resetsAt: nextUtcMonth(nowMs) },
      ] as const;
      let readable = 0;
      for (const window of windows) {
        let spend = 0;
        for (const dbPath of dbPaths) {
          try {
            spend += await this.openCodeSpend(dbPath, window.sinceMs);
            readable += 1;
          } catch {
            /* skip databases from incompatible OpenCode versions */
          }
        }
        resources[window.key] = {
          kind: "consumption",
          unit: "USD",
          used: round2(spend),
          ...(hasGoPlan
            ? { limit: window.limit, utilization: clampUtilization(spend / window.limit) }
            : {}),
          ...("resetsAt" in window ? { resetsAt: new Date(window.resetsAt).toISOString() } : {}),
        };
        hasAny = true;
      }
      if (readable === 0 && !resources.balance)
        throw new UsageFailure("invalid_response", "OpenCode usage database could not be read.");
      if (hasGoPlan) plan = plan ? `${plan}+Go` : "Go";
    } catch (cause) {
      if (!hasAny) throw cause;
    }

    return this.provider("OpenCode", plan, resources);
  }

  /** Zen credit balance via opencode.ai console cookie (SolidStart billing RPC). */
  private async fetchOpenCodeZenBalance(): Promise<number | undefined> {
    const cookie =
      string(this.env.OPENCODE_AUTH_COOKIE) ?? string(this.env.T3CODE_OPENCODE_AUTH_COOKIE);
    if (!cookie) return undefined;
    const workspaceId =
      string(this.env.OPENCODE_WORKSPACE_ID) ??
      string(this.env.T3CODE_OPENCODE_WORKSPACE_ID) ??
      (await this.discoverOpenCodeWorkspaceId(cookie));
    if (!workspaceId) return undefined;
    // Pinned server-fn id from OpenUsage (captured 2026-04-30). Rotates on console deploys.
    const rpcBillingInfoId = "c83b78a614689c38ebee981f9b39a8b377716db85c1fd7dbab604adc02d3313d";
    const args = JSON.stringify({
      t: { t: 9, i: 0, l: 1, a: [{ t: 1, s: workspaceId }], o: 0 },
      f: 31,
      m: [],
    });
    const url = `https://opencode.ai/_server?id=${rpcBillingInfoId}&args=${encodeURIComponent(args)}`;
    const response = await this.fetch(url, {
      method: "GET",
      headers: {
        Accept: "*/*",
        "x-server-id": rpcBillingInfoId,
        Cookie: `auth=${cookie}`,
        "User-Agent": "t3code-usage/1.0",
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) return undefined;
    const body = await response.text();
    const match = /balance:(-?\d+(?:\.\d+)?)/u.exec(body);
    if (!match?.[1]) return undefined;
    const raw = Number(match[1]);
    if (!Number.isFinite(raw)) return undefined;
    // OpenCode console stores balance in 1e-8 USD units.
    return round2(raw / 1e8);
  }

  private async discoverOpenCodeWorkspaceId(cookie: string): Promise<string | undefined> {
    try {
      const response = await this.fetch("https://opencode.ai/auth", {
        method: "GET",
        redirect: "manual",
        headers: {
          Cookie: `auth=${cookie}`,
          "User-Agent": "t3code-usage/1.0",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const location = response.headers.get("location") ?? "";
      const match = /\/workspace\/([^/?#]+)/u.exec(location);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  private async fetchCursor(): Promise<UsageProvider> {
    const token = await resolveProviderKey("cursor", this.credentialContext());
    if (!token) throw new UsageFailure("no_credentials", "Cursor login is not available.");

    const body = await this.postJson(
      "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
      token,
    );
    const planUsage = object(body.planUsage) ?? {};
    const resources: Record<string, UsageResource> = {};
    const totalPercent = number(planUsage.totalPercentUsed);
    if (totalPercent !== undefined) {
      resources.plan = {
        kind: "consumption",
        unit: "percent",
        used: totalPercent,
        limit: 100,
        utilization: clampUtilization(totalPercent / 100),
        ...(isoDate(body.billingCycleEnd) ? { resetsAt: isoDate(body.billingCycleEnd) } : {}),
      };
    }
    const autoPercent = number(planUsage.autoPercentUsed);
    if (autoPercent !== undefined) {
      resources.auto = {
        kind: "consumption",
        unit: "percent",
        used: autoPercent,
        limit: 100,
        utilization: clampUtilization(autoPercent / 100),
      };
    }
    const apiPercent = number(planUsage.apiPercentUsed);
    if (apiPercent !== undefined) {
      resources.api = {
        kind: "consumption",
        unit: "percent",
        used: apiPercent,
        limit: 100,
        utilization: clampUtilization(apiPercent / 100),
      };
    }

    let planName: string | undefined;
    try {
      const planInfo = await this.postJson(
        "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo",
        token,
      );
      planName = string(object(planInfo.planInfo)?.planName);
    } catch {
      /* plan name is optional */
    }

    return this.provider("Cursor", planName, resources);
  }

  private openCodeDataDir(): string {
    const explicit = string(this.env.OPENCODE_DATA_DIR);
    if (explicit) return explicit;
    const xdgDataHome = string(this.env.XDG_DATA_HOME);
    return xdgDataHome
      ? NodePath.join(xdgDataHome, "opencode")
      : NodePath.join(this.homeDir, ".local", "share", "opencode");
  }

  private storedCredentialsIo(): StoredCredentialsIo {
    return { homeDir: this.homeDir, readFile: this.readFile, writeFile: this.writeFile };
  }

  private async readStoredCredentials(): Promise<Record<string, string>> {
    return readStoredCredentials(this.storedCredentialsIo());
  }

  private async storedCredential(provider: StoredCredentialProvider): Promise<string | undefined> {
    return (await this.readStoredCredentials())[provider];
  }

  /** Persist (or clear, with `null`) a pasted key for a family. */
  async setStoredCredential(
    provider: StoredCredentialProvider,
    token: string | null,
  ): Promise<void> {
    await writeStoredCredential(provider, token, this.storedCredentialsIo());
    // The next poll must judge with the new credential, not the cached verdict.
    this.cache = undefined;
  }

  /** The context the shared credential table walks for this service instance. */
  private credentialContext(): Partial<ProviderCredentialContext> {
    return {
      homeDir: this.homeDir,
      env: this.env,
      readFile: this.readFile,
      readCursorAccessToken: this.readCursorAccessToken,
    };
  }

  /**
   * Which source feeds each family's usage numbers, straight from the shared
   * credential table so the reported label is the source a fetcher would use.
   * Reports labels only — tokens never cross this boundary.
   */
  async credentialStatuses(): Promise<ReadonlyArray<UsageCredentialStatus>> {
    const context = this.credentialContext();
    return Promise.all(
      USAGE_PROVIDER_IDS.map(async (providerId) => ({
        providerId,
        writable: PROVIDER_CREDENTIALS[providerId].writable,
        source: await resolveProviderCredentialSource(providerId, context),
      })),
    );
  }

  private provider(
    displayName: string,
    plan: string | undefined,
    resources: Record<string, UsageResource>,
  ): UsageProvider {
    if (Object.keys(resources).length === 0)
      throw new UsageFailure(
        "invalid_response",
        `${displayName} did not return any supported usage limits.`,
      );
    return {
      displayName,
      ...(plan ? { plan } : {}),
      fetchedAt: this.now().toISOString(),
      resources,
    };
  }

  // Issue the usage request; on a 401/403 refresh the CLI token once and retry so a token that lapsed
  // between the expiry check and the request still succeeds.
  private async getJsonWithRefresh(
    url: string,
    token: string,
    buildHeaders: (bearer: string) => Record<string, string>,
    refresh?: () => Promise<string | undefined>,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.getJson(url, buildHeaders(token));
    } catch (cause) {
      if (cause instanceof UsageFailure && cause.code === "unauthorized" && refresh) {
        const refreshed = await refresh();
        if (refreshed) return this.getJson(url, buildHeaders(refreshed));
      }
      throw cause;
    }
  }

  private isExpired(expiresAtMs: number | undefined): boolean {
    if (expiresAtMs === undefined) return false;
    // Refresh a minute early to avoid racing the token's own expiry.
    return this.now().getTime() >= expiresAtMs - 60_000;
  }

  private async refreshClaudeToken(
    refreshToken: string,
    path: string,
    auth: Record<string, unknown>,
    oauth: Record<string, unknown>,
  ): Promise<string | undefined> {
    const result = await this.refreshOAuthToken(
      [
        process.env.CLAUDE_OAUTH_TOKEN_URL,
        "https://console.anthropic.com/v1/oauth/token",
        "https://platform.claude.com/v1/oauth/token",
      ],
      {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: process.env.CLAUDE_OAUTH_CLIENT_ID ?? "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      },
    );
    const accessToken = string(result?.access_token);
    if (!accessToken) return undefined;
    const expiresIn = number(result?.expires_in);
    await this.persistCredentials(path, {
      ...auth,
      claudeAiOauth: {
        ...oauth,
        accessToken,
        refreshToken: string(result?.refresh_token) ?? refreshToken,
        ...(expiresIn ? { expiresAt: this.now().getTime() + expiresIn * 1_000 } : {}),
      },
    });
    return accessToken;
  }

  private async refreshCodexToken(
    refreshToken: string,
    path: string,
    auth: Record<string, unknown>,
    tokens: Record<string, unknown>,
  ): Promise<string | undefined> {
    const result = await this.refreshOAuthToken(
      [process.env.CODEX_OAUTH_TOKEN_URL, "https://auth.openai.com/oauth/token"],
      {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: process.env.CODEX_OAUTH_CLIENT_ID ?? "app_EMoamEEZ73f0CkXaXp7hrann",
        scope: "openid profile email",
      },
    );
    const accessToken = string(result?.access_token);
    if (!accessToken) return undefined;
    await this.persistCredentials(path, {
      ...auth,
      tokens: {
        ...tokens,
        access_token: accessToken,
        refresh_token: string(result?.refresh_token) ?? refreshToken,
        ...(string(result?.id_token) ? { id_token: string(result?.id_token) } : {}),
      },
      last_refresh: this.now().toISOString(),
    });
    return accessToken;
  }

  // Try each token endpoint in turn. A bad refresh token (401/403) is terminal; transport/404 errors
  // fall through to the next candidate host.
  private async refreshOAuthToken(
    endpoints: ReadonlyArray<string | undefined>,
    body: Record<string, string>,
  ): Promise<Record<string, unknown> | undefined> {
    for (const endpoint of endpoints) {
      if (!endpoint) continue;
      try {
        return await this.postOAuthJson(endpoint, body);
      } catch (cause) {
        if (cause instanceof UsageFailure && cause.code === "unauthorized") throw cause;
      }
    }
    return undefined;
  }

  private async postOAuthJson(
    url: string,
    body: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "TimeoutError")
        throw new UsageFailure("timeout", "Token refresh timed out.");
      throw new UsageFailure("unavailable", "Token refresh request failed.");
    }
    if (response.status === 401 || response.status === 403)
      throw new UsageFailure("unauthorized", "CLI login could not be refreshed. Sign in again.");
    if (!response.ok)
      throw new UsageFailure("unavailable", `Token refresh failed (HTTP ${response.status}).`);
    try {
      return object(await response.json()) ?? {};
    } catch {
      throw new UsageFailure("invalid_response", "Token refresh returned invalid data.");
    }
  }

  private async persistCredentials(path: string, data: Record<string, unknown>): Promise<void> {
    try {
      await this.writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
    } catch {
      // Best effort: the refreshed token is still used in-memory for this request even if the CLI's
      // credentials file cannot be updated (e.g. read-only mount).
    }
  }

  private async postJson(url: string, token: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "TimeoutError")
        throw new UsageFailure("timeout", "Usage request timed out.");
      throw new UsageFailure("unavailable", "Usage request failed.");
    }
    if (response.status === 401 || response.status === 403)
      throw new UsageFailure(
        "unauthorized",
        "CLI login cannot read subscription usage. Sign in again.",
      );
    if (!response.ok)
      throw new UsageFailure("unavailable", `Usage request failed (HTTP ${response.status}).`);
    try {
      return object(await response.json()) ?? {};
    } catch {
      throw new UsageFailure("invalid_response", "Usage service returned invalid data.");
    }
  }

  private async getJson(
    url: string,
    headers: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "TimeoutError")
        throw new UsageFailure("timeout", "Usage request timed out.");
      throw new UsageFailure("unavailable", "Usage request failed.");
    }
    if (response.status === 401 || response.status === 403)
      throw new UsageFailure(
        "unauthorized",
        "CLI login cannot read subscription usage. Sign in again.",
      );
    if (!response.ok)
      throw new UsageFailure("unavailable", `Usage request failed (HTTP ${response.status}).`);
    try {
      return object(await response.json()) ?? {};
    } catch {
      throw new UsageFailure("invalid_response", "Usage service returned invalid data.");
    }
  }

  private async readJsonFirst(
    paths: ReadonlyArray<string>,
  ): Promise<{ path: string; data: Record<string, unknown> }> {
    for (const path of paths) {
      try {
        return { path, data: object(JSON.parse(await this.readFile(path))) ?? {} };
      } catch {
        /* try next credential location */
      }
    }
    throw new UsageFailure("no_credentials", "CLI login is not available.");
  }
}

class UsageFailure extends Error {
  readonly code: UsageError["code"];
  constructor(code: UsageError["code"], message: string) {
    super(message);
    this.code = code;
  }
}
function usageError(providerId: UsageProviderId, cause: unknown): UsageError {
  if (cause instanceof UsageFailure)
    return { providerId, code: cause.code, message: cause.message };
  return { providerId, code: "unavailable", message: "Usage is temporarily unavailable." };
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function isoDate(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/u.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric)) return undefined;
      const ms = numeric < 1e12 ? numeric * 1000 : numeric;
      const date = new Date(ms);
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return undefined;
}

/**
 * Read a Cursor access token.
 *
 * Two independent credential stores exist and a headless box only ever has the
 * second: the Cursor IDE writes `state.vscdb`, while `cursor-agent login`
 * writes a JSON file under the CLI's own data dir. Reading only the IDE store
 * made `/api/usage` report "Cursor login is not available" on a VPS whose
 * `cursor-agent about` says authenticated — which then marked the provider
 * unusable in the picker.
 */
export async function readCursorAccessToken(
  homeDir: string,
  env: Record<string, string | undefined>,
  readFile: (path: string) => Promise<string>,
): Promise<string | undefined> {
  return (
    (await readCursorTokenFromStateDb(homeDir, env)) ??
    (await readCursorTokenFromCliConfig(homeDir, env, readFile))
  );
}

async function readCursorTokenFromStateDb(
  homeDir: string,
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  const candidates = cursorStateDbPaths(homeDir, env);
  for (const dbPath of candidates) {
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = db
          .prepare("SELECT value FROM ItemTable WHERE key = ?")
          .get("cursorAuth/accessToken") as { value?: unknown } | undefined;
        const token = typeof row?.value === "string" ? row.value.trim() : undefined;
        if (token) return token;
      } finally {
        db.close();
      }
    } catch {
      /* try next path */
    }
  }
  return undefined;
}

function cursorStateDbPaths(
  homeDir: string,
  env: Record<string, string | undefined>,
): ReadonlyArray<string> {
  const explicit = string(env.CURSOR_STATE_DB) ?? string(env.T3CODE_CURSOR_STATE_DB);
  const paths: Array<string> = [];
  if (explicit) paths.push(explicit);
  const appData = string(env.APPDATA);
  if (appData) {
    paths.push(NodePath.join(appData, "Cursor", "User", "globalStorage", "state.vscdb"));
  }
  paths.push(
    NodePath.join(homeDir, "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb"),
    NodePath.join(
      homeDir,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    ),
    NodePath.join(homeDir, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
  );
  return paths;
}

async function readCursorTokenFromCliConfig(
  homeDir: string,
  env: Record<string, string | undefined>,
  readFile: (path: string) => Promise<string>,
): Promise<string | undefined> {
  for (const path of cursorCliConfigPaths(homeDir, env)) {
    try {
      const parsed: unknown = JSON.parse(await readFile(path));
      const token = findCursorTokenField(parsed, 0);
      if (token) return token;
    } catch {
      /* try next path */
    }
  }
  return undefined;
}

function cursorCliConfigPaths(
  homeDir: string,
  env: Record<string, string | undefined>,
): ReadonlyArray<string> {
  const explicit = string(env.CURSOR_CLI_CONFIG) ?? string(env.T3CODE_CURSOR_CLI_CONFIG);
  const dataHome = string(env.XDG_DATA_HOME) ?? NodePath.join(homeDir, ".local", "share");
  const configHome = string(env.XDG_CONFIG_HOME) ?? NodePath.join(homeDir, ".config");
  return [
    ...(explicit ? [explicit] : []),
    NodePath.join(homeDir, ".cursor", "cli-config.json"),
    NodePath.join(homeDir, ".cursor", "auth.json"),
    NodePath.join(dataHome, "cursor-agent", "credentials.json"),
    NodePath.join(dataHome, "cursor-agent", "auth.json"),
    NodePath.join(dataHome, "cursor-agent", "config.json"),
    NodePath.join(configHome, "cursor-agent", "credentials.json"),
    NodePath.join(configHome, "cursor-agent", "auth.json"),
  ];
}

const CURSOR_TOKEN_FIELDS = [
  "accessToken",
  "access_token",
  "cursorAuth/accessToken",
  "authToken",
  "token",
];

// The CLI's file shape is not a published contract and has already moved once
// (flat, then nested under `auth`), so match on the field name at any depth
// rather than pinning a path that a Cursor release can invalidate.
function findCursorTokenField(value: unknown, depth: number): string | undefined {
  if (depth > 4) return undefined;
  const record = object(value);
  if (!record) return undefined;
  for (const field of CURSOR_TOKEN_FIELDS) {
    const token = string(record[field]);
    if (token) return token;
  }
  for (const nested of Object.values(record)) {
    const token = findCursorTokenField(nested, depth + 1);
    if (token) return token;
  }
  return undefined;
}

function addPercent(resources: Record<string, UsageResource>, key: string, raw: unknown): void {
  const window = object(raw);
  const resource = normalizePercentageResource({
    usedPercent: window?.used_percent ?? window?.utilization ?? window?.percent,
    resetsAt: window?.reset_at ?? window?.resets_at,
  });
  if (resource) resources[key] = resource;
}
function grokHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    Accept: "application/json",
  };
}
function claudeHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "anthropic-beta": "oauth-2025-04-20",
    // A versioned claude-code User-Agent keeps the request out of the anonymous, aggressively
    // rate-limited bucket that answers bare or missing agents with persistent 429s.
    "User-Agent": "claude-cli/1.0.0 (external, cli)",
  };
}
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
function startOfUtcWeek(nowMs: number): number {
  const date = new Date(nowMs);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceMonday);
}
function startOfUtcMonth(nowMs: number): number {
  const date = new Date(nowMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}
function nextUtcMonth(nowMs: number): number {
  const date = new Date(nowMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}
// Sums assistant-message spend recorded by OpenCode for its hosted gateway since `sinceMs`.
// `node:sqlite` is imported lazily so runtimes without it only fail the OpenCode provider.
async function readOpenCodeSpend(dbPath: string, sinceMs: number): Promise<number> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(CAST(json_extract(data, '$.cost') AS REAL)), 0) AS spend
         FROM message
         WHERE json_extract(data, '$.role') = 'assistant'
           AND COALESCE(json_extract(data, '$.providerID'), '') LIKE 'opencode%'
           AND COALESCE(json_extract(data, '$.time.created'), time_created, 0) >= ?`,
      )
      .get(sinceMs) as { spend?: number } | undefined;
    return typeof row?.spend === "number" && Number.isFinite(row.spend) ? row.spend : 0;
  } finally {
    db.close();
  }
}
// Milliseconds-since-epoch expiry from a JWT's `exp` claim, or undefined when the token is opaque.
function jwtExpMs(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = object(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    const exp = number(claims?.exp);
    return exp === undefined ? undefined : exp * 1_000;
  } catch {
    return undefined;
  }
}
