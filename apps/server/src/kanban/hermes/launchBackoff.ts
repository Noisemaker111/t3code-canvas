/**
 * What a card that could not be launched has to wait.
 *
 * A launch that fails leaves the card exactly as it was — ready, in Prompts,
 * with a project — which is indistinguishable from fresh work, so the rule pass
 * launched it again every heartbeat. The durable operation store cannot stop
 * that on its own: its idempotency key is scoped to the board fingerprint, and
 * a spiralling board changes that every tick, which mints a new key and a fresh
 * retry budget. This is the card-scoped memory the retry actually needs.
 *
 * @module kanban/hermes/launchBackoff
 */

/** Failed launches before the card stops being re-picked and needs a human. */
export const LAUNCH_ATTEMPT_LIMIT = 3;

const FIRST_BACKOFF_MS = 120_000;
const BACKOFF_FACTOR = 4;

type LaunchFailure = {
  readonly failures: number;
  readonly retryAtMs: number;
  readonly error: string;
};

const failures = new Map<string, LaunchFailure>();

export function resetLaunchBackoff(): void {
  failures.clear();
}

export function launchFailure(cardId: string): LaunchFailure | null {
  return failures.get(cardId) ?? null;
}

/** True once the card has spent its attempts: only a human moves it now. */
export function launchExhausted(cardId: string): boolean {
  return (failures.get(cardId)?.failures ?? 0) >= LAUNCH_ATTEMPT_LIMIT;
}

/** Milliseconds left before this card may be launched again, or null when it may. */
export function launchBlockedForMs(cardId: string, nowMs: number): number | null {
  const failure = failures.get(cardId);
  if (!failure) return null;
  const remaining = failure.retryAtMs - nowMs;
  return remaining > 0 ? remaining : null;
}

export function recordLaunchFailure(input: {
  readonly cardId: string;
  readonly error: string;
  readonly nowMs: number;
}): LaunchFailure {
  const previous = failures.get(input.cardId)?.failures ?? 0;
  const count = previous + 1;
  const next: LaunchFailure = {
    failures: count,
    retryAtMs: input.nowMs + FIRST_BACKOFF_MS * BACKOFF_FACTOR ** (count - 1),
    error: input.error,
  };
  failures.set(input.cardId, next);
  return next;
}

export function clearLaunchFailures(cardId: string): void {
  failures.delete(cardId);
}
