import { useCallback, useSyncExternalStore } from "react";

import {
  createUsageRefreshController,
  initialUsageFetchState,
  type UsageFetchState,
  type UsageRefreshController,
} from "../components/UsageIndicator.logic";

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const FAILURE_RETRY_MS = 60 * 1000;

/**
 * Process-wide usage snapshot so the AI usage panel, model picker, and Board
 * settings share one `/api/usage` poll instead of each spinning a controller.
 */
type SharedUsageStore = {
  state: UsageFetchState;
  controller: UsageRefreshController | null;
  listeners: Set<() => void>;
  intervalId: ReturnType<typeof setInterval> | null;
  failureRetryId: ReturnType<typeof setTimeout> | null;
  subscriberCount: number;
};

const store: SharedUsageStore = {
  state: initialUsageFetchState,
  controller: null,
  listeners: new Set(),
  intervalId: null,
  failureRetryId: null,
  subscriberCount: 0,
};

function emit(next: UsageFetchState): void {
  store.state = next;
  for (const listener of store.listeners) {
    listener();
  }
  if (next.failedAttempts > 0 && store.subscriberCount > 0 && !store.failureRetryId) {
    store.failureRetryId = setTimeout(() => {
      store.failureRetryId = null;
      void store.controller?.refresh();
    }, FAILURE_RETRY_MS);
  }
}

function ensureController(): UsageRefreshController {
  if (store.controller) return store.controller;
  const controller = createUsageRefreshController({
    onChange: emit,
  });
  store.controller = controller;
  return controller;
}

function subscribe(listener: () => void): () => void {
  store.listeners.add(listener);
  store.subscriberCount += 1;
  if (store.subscriberCount === 1) {
    const controller = ensureController();
    void controller.refresh();
    store.intervalId = setInterval(() => void controller.refresh(), REFRESH_INTERVAL_MS);
  }
  return () => {
    store.listeners.delete(listener);
    store.subscriberCount = Math.max(0, store.subscriberCount - 1);
    if (store.subscriberCount === 0) {
      if (store.intervalId !== null) {
        clearInterval(store.intervalId);
        store.intervalId = null;
      }
      if (store.failureRetryId !== null) {
        clearTimeout(store.failureRetryId);
        store.failureRetryId = null;
      }
      store.controller?.dispose();
      store.controller = null;
      store.state = initialUsageFetchState;
    }
  };
}

function getSnapshot(): UsageFetchState {
  return store.state;
}

/** Shared `/api/usage` snapshot for pickers + the usage panel. */
export function useUsageSnapshot(): UsageFetchState & {
  refresh: (force?: boolean) => Promise<void>;
} {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const refresh = useCallback((force = false) => ensureController().refresh(force), []);

  return {
    ...state,
    refresh,
  };
}
