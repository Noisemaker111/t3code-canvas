/**
 * The one client-side store for pasted provider API keys (`/api/usage/credentials`).
 *
 * Keys are write-only across this boundary: the server reports source labels
 * ("stored token", "env:OPENROUTER_API_KEY", a file path), never the secret.
 * Subscribers share a single fetch so a key saved in one pane refreshes the
 * source label everywhere else.
 *
 * @module usageCredentials
 */
import { useEffect, useState } from "react";

export type UsageCredentialStatus = {
  readonly providerId: string;
  readonly source: string | null;
  readonly writable: boolean;
};

export type UsageCredentialsState = {
  readonly statuses: ReadonlyArray<UsageCredentialStatus> | null;
  readonly error: string | null;
};

let state: UsageCredentialsState = { statuses: null, error: null };
let inFlight: Promise<void> | null = null;
const subscribers = new Set<(next: UsageCredentialsState) => void>();

const publish = (next: UsageCredentialsState) => {
  state = next;
  for (const subscriber of subscribers) subscriber(state);
};

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

async function load(): Promise<void> {
  try {
    const response = await fetch("/api/usage/credentials");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as {
      credentials?: ReadonlyArray<UsageCredentialStatus>;
    };
    publish({ statuses: body.credentials ?? [], error: null });
  } catch (cause) {
    publish({ statuses: state.statuses, error: message(cause) });
  }
}

function refresh(): Promise<void> {
  inFlight ??= load().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Save (`token`) or clear (`null`) a family's key, then republish statuses. */
export async function saveUsageCredential(family: string, token: string | null): Promise<void> {
  const response = await fetch("/api/usage/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: family, token }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { credentials?: ReadonlyArray<UsageCredentialStatus> };
  publish({ statuses: body.credentials ?? [], error: null });
}

export function useUsageCredentials(): UsageCredentialsState {
  const [snapshot, setSnapshot] = useState(state);
  useEffect(() => {
    subscribers.add(setSnapshot);
    void refresh();
    return () => {
      subscribers.delete(setSnapshot);
    };
  }, []);
  return snapshot;
}

export function usageCredentialStatus(
  statuses: ReadonlyArray<UsageCredentialStatus> | null,
  family: string,
): UsageCredentialStatus | null {
  return statuses?.find((entry) => entry.providerId === family) ?? null;
}
