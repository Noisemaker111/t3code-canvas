/** Client for `/api/maintenance` — what history has piled up, and how to delete it. */
export type MaintenanceTargetId = "friction" | "archived" | "hermes-logs" | "health" | "canvas";

export type MaintenanceLine = {
  readonly label: string;
  readonly count: number;
};

export type MaintenanceSurvey = {
  readonly target: MaintenanceTargetId;
  readonly title: string;
  readonly summary: string;
  readonly items: number;
  readonly bytes: number;
  readonly lines: ReadonlyArray<MaintenanceLine>;
  /** Non-null means the dialog demands this phrase typed back before it enables. */
  readonly requiresPhrase: string | null;
};

export type MaintenancePurgeResult = MaintenanceSurvey & { readonly purgedAt: string };

async function json<A>(input: string, init?: RequestInit): Promise<A> {
  const response = await fetch(input, { credentials: "same-origin", ...init });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${init?.method ?? "GET"} ${input} failed (${response.status})`);
  }
  return (await response.json()) as A;
}

export const fetchMaintenance = (): Promise<{ surveys: ReadonlyArray<MaintenanceSurvey> }> =>
  json<{ surveys: ReadonlyArray<MaintenanceSurvey> }>("/api/maintenance");

/**
 * `confirmItems` is the count the dialog showed. The server re-surveys and
 * refuses a mismatch, so a stale dialog can never delete more than it named.
 */
export const purgeMaintenanceTarget = (input: {
  readonly target: MaintenanceTargetId;
  readonly confirmItems: number;
  readonly confirmPhrase?: string;
}): Promise<{ result: MaintenancePurgeResult }> =>
  json<{ result: MaintenancePurgeResult }>("/api/maintenance/purge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}
