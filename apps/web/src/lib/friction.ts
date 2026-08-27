/** Client for `/api/friction` — the papercut log and its status flags. */
export type FrictionSource = "agent" | "detector" | "board";
export type FrictionScope = "harness" | "repo" | "env" | "upstream";
export type FrictionStatus = "open" | "carded" | "fixed" | "wontfix";

export type FrictionEntry = {
  readonly fingerprint: string;
  readonly source: FrictionSource;
  readonly scope: FrictionScope;
  readonly tool: string;
  readonly summary: string;
  readonly evidence: string | null;
  readonly workaround: string | null;
  readonly count: number;
  readonly threadIds: ReadonlyArray<string>;
  readonly cardIds: ReadonlyArray<string>;
  readonly context: Readonly<Record<string, string>>;
  readonly status: FrictionStatus;
  readonly fixCardId: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
};

async function json<A>(input: string, init?: RequestInit): Promise<A> {
  const response = await fetch(input, { credentials: "same-origin", ...init });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `${init?.method ?? "GET"} ${input} failed (${response.status})`);
  }
  return (await response.json()) as A;
}

export const fetchFriction = (): Promise<{
  entries: ReadonlyArray<FrictionEntry>;
}> => json<{ entries: ReadonlyArray<FrictionEntry> }>("/api/friction");

export const setFrictionStatus = (
  fingerprint: string,
  status: FrictionStatus,
): Promise<{ entry: FrictionEntry }> =>
  json<{ entry: FrictionEntry }>("/api/friction/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fingerprint, status }),
  });

export const FRICTION_SOURCE_LABELS: Record<FrictionSource, string> = {
  agent: "Reported by an agent",
  detector: "Caught by the detector",
  board: "Hermes board call",
};

export const FRICTION_STATUS_LABELS: Record<FrictionStatus, string> = {
  open: "Open",
  carded: "Carded",
  fixed: "Fixed",
  wontfix: "Won't fix",
};
