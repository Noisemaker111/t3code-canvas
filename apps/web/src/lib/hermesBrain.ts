/** Client for `/api/hermes/brain` — status, config, the log and the run harness. */
import type {
  HermesBrainStatus,
  HermesChatEntry,
  HermesConversationStatus,
  HermesTickTranscript,
  HermesTier,
} from "@t3tools/contracts";

export type HermesBrainConfigPayload = {
  readonly enabled?: boolean;
  readonly instanceId?: string;
  readonly model?: string;
  readonly intervalMs?: number;
  readonly maxNudges?: number;
};

async function json<A>(input: string, init?: RequestInit): Promise<A> {
  const response = await fetch(input, { credentials: "same-origin", ...init });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${init?.method ?? "GET"} ${input} failed (${response.status})`);
  }
  return (await response.json()) as A;
}

export const fetchHermesBrainStatus = (): Promise<HermesBrainStatus> =>
  json<HermesBrainStatus>("/api/hermes/brain");

export const configureHermesBrain = (
  payload: HermesBrainConfigPayload,
): Promise<HermesBrainStatus> =>
  json<HermesBrainStatus>("/api/hermes/brain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

export const runHermesBrainDryRun = (): Promise<HermesTickTranscript> =>
  json<HermesTickTranscript>("/api/hermes/brain/dry-run", { method: "POST" });

/** One real tick, now. Writes to the board; 409s while Hermes is off. */
export const runHermesBrainTick = (): Promise<HermesTickTranscript> =>
  json<HermesTickTranscript>("/api/hermes/brain/tick", { method: "POST" });

/** Wipe the persisted conversation; the next tick starts from a full snapshot. */
export const resetHermesBrainConversation = (): Promise<HermesConversationStatus> =>
  json<HermesConversationStatus>("/api/hermes/brain/conversation/reset", { method: "POST" });

/** Every turn the loop sent and every answer it acted on, oldest first. */
export const fetchHermesChat = (limit = 80): Promise<{ entries: ReadonlyArray<HermesChatEntry> }> =>
  json<{ entries: ReadonlyArray<HermesChatEntry> }>(`/api/hermes/chat?limit=${limit}`);

export const fetchHermesTick = (id: string): Promise<HermesTickTranscript> =>
  json<HermesTickTranscript>(`/api/hermes/brain/log?id=${encodeURIComponent(id)}`);

export const HERMES_TIER_LABELS: Record<HermesTier, string> = {
  cursor: "cursor-agent",
  xai: "xAI (grok CLI)",
  codex: "Codex (ChatGPT)",
  openrouter: "OpenRouter",
};

export const HERMES_TIER_HINTS: Record<HermesTier, string> = {
  cursor: "Local CLI over ACP. Uses your Cursor subscription, no API key.",
  xai: "Local grok CLI over ACP. Needs XAI_API_KEY or a cached login.",
  codex: "Local codex app-server. Uses your ChatGPT subscription; needs `codex login`.",
  openrouter: "Plain HTTPS. Needs an OpenRouter key; bills per token.",
};
