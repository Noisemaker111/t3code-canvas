import type { UsageResponse } from "~/lib/providerUsage";

/**
 * State machine behind the AI usage panel's fetch cycle.
 *
 * Kept free of React so the failure modes that used to wedge the panel are unit-testable:
 * a fetch that never settles (stalled tunnel), a fetch implementation that ignores its
 * AbortSignal, overlapping manual/interval refreshes, and late responses from superseded
 * cycles. Every refresh cycle is guaranteed to settle within a bounded time and to leave
 * `isRefreshing` false, so the UI can always render either data or an error.
 */

export type UsageFetchState = {
  readonly data: UsageResponse | null;
  readonly error: string | null;
  readonly isRefreshing: boolean;
  /** ISO timestamp of the last successful fetch, for the "Updated …" footer. */
  readonly lastSuccessAt: string | null;
  readonly failedAttempts: number;
};

export const initialUsageFetchState: UsageFetchState = {
  data: null,
  error: null,
  isRefreshing: false,
  lastSuccessAt: null,
  failedAttempts: 0,
};

export type UsageRefreshController = {
  refresh: (force?: boolean) => Promise<void>;
  dispose: () => void;
  readonly state: UsageFetchState;
};

export type UsageRefreshOptions = {
  readonly onChange: (state: UsageFetchState) => void;
  readonly url?: string;
  readonly fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Hard per-request deadline. The attempt settles even if fetchImpl ignores its signal. */
  readonly attemptTimeoutMs?: number;
  readonly retryDelaysMs?: ReadonlyArray<number>;
  readonly now?: () => number;
};

type AttemptResult =
  | { readonly ok: true; readonly data: UsageResponse }
  | {
      readonly ok: false;
      readonly error: string;
      readonly retriable: boolean;
      readonly superseded?: boolean;
    };

const DEFAULT_URL = "/api/usage";
const DEFAULT_ATTEMPT_TIMEOUT_MS = 12_000;
// Quick in-flight retries before surfacing an error: tunnel restarts and deploys show up as
// transient 502s that usually clear within seconds.
const DEFAULT_RETRY_DELAYS_MS = [0, 2_000, 5_000];

export function createUsageRefreshController(options: UsageRefreshOptions): UsageRefreshController {
  const url = options.url ?? DEFAULT_URL;
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const now = options.now ?? Date.now;

  let state = initialUsageFetchState;
  let generation = 0;
  let activeCycle: AbortController | null = null;
  let disposed = false;

  const emit = (patch: Partial<UsageFetchState>): void => {
    state = { ...state, ...patch };
    options.onChange(state);
  };

  /**
   * One HTTP attempt with a hard deadline. Resolves (never rejects, never hangs) even when
   * the fetch implementation ignores abort signals: the timeout settles the promise directly.
   */
  const attempt = (requestUrl: string, cycleSignal: AbortSignal): Promise<AttemptResult> =>
    new Promise((resolve) => {
      const abort = new AbortController();
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onCycleAbort = (): void => {
        abort.abort();
        settle({ ok: false, error: "Refresh superseded", retriable: false, superseded: true });
      };
      const settle = (result: AttemptResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        cycleSignal.removeEventListener("abort", onCycleAbort);
        resolve(result);
      };
      timer = setTimeout(() => {
        abort.abort();
        settle({
          ok: false,
          error: `Usage request timed out after ${Math.round(attemptTimeoutMs / 1000)}s`,
          retriable: true,
        });
      }, attemptTimeoutMs);
      if (cycleSignal.aborted) {
        onCycleAbort();
        return;
      }
      cycleSignal.addEventListener("abort", onCycleAbort, { once: true });
      void (async () => {
        try {
          const response = await fetchImpl(requestUrl, {
            credentials: "same-origin",
            cache: "no-store",
            signal: abort.signal,
          });
          if (!response.ok) {
            settle({
              ok: false,
              error: `Usage endpoint returned ${response.status}`,
              // 4xx responses (expired login session) will not improve on immediate retry.
              retriable: response.status >= 500 || response.status === 429,
            });
            return;
          }
          const data = (await response.json()) as UsageResponse;
          settle({ ok: true, data });
        } catch (cause) {
          settle({
            ok: false,
            error:
              cause instanceof Error && cause.name !== "AbortError"
                ? cause.message
                : "Failed to load usage",
            retriable: true,
          });
        }
      })();
    });

  const delay = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal.aborted || ms <= 0) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });

  const refresh = async (force = false): Promise<void> => {
    if (disposed) return;
    if (activeCycle) {
      // Interval/background refreshes are single-flight; an explicit user refresh replaces
      // the running cycle so the button always responds to the click.
      if (!force) return;
      activeCycle.abort();
    }
    const cycleGeneration = ++generation;
    const cycle = new AbortController();
    activeCycle = cycle;
    emit({ isRefreshing: true });
    const requestUrl = force ? `${url}?force=1` : url;
    let failure = "Failed to load usage";
    try {
      for (const delayMs of retryDelaysMs) {
        if (delayMs > 0) await delay(delayMs, cycle.signal);
        if (cycle.signal.aborted || disposed) return;
        const result = await attempt(requestUrl, cycle.signal);
        // A newer cycle owns the state now; this one must not write anything.
        if (generation !== cycleGeneration) return;
        if (result.ok) {
          emit({
            data: result.data,
            error: null,
            isRefreshing: false,
            failedAttempts: 0,
            lastSuccessAt: new Date(now()).toISOString(),
          });
          return;
        }
        if (result.superseded) return;
        failure = result.error;
        if (!result.retriable) break;
      }
      // Keep the last-known-good data on failures; only the error banner updates.
      emit({
        error: failure,
        isRefreshing: false,
        failedAttempts: state.failedAttempts + 1,
      });
    } finally {
      if (activeCycle === cycle) activeCycle = null;
      // Belt and braces: whatever path exited above, the current cycle must never leave the
      // spinner stuck on. (A stuck "Refreshing…" with the button disabled is the exact
      // production failure this module exists to prevent.)
      if (generation === cycleGeneration && !disposed && state.isRefreshing) {
        emit({ isRefreshing: false });
      }
    }
  };

  const dispose = (): void => {
    disposed = true;
    activeCycle?.abort();
    activeCycle = null;
  };

  return {
    refresh,
    dispose,
    get state() {
      return state;
    },
  };
}
