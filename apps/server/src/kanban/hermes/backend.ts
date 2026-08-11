/**
 * Hermes backend — one completion from the one provider the board settings
 * name. There is no fallback: a chain hides which provider the owner chose and
 * keeps a tick alive on a transport they did not pick, so an unavailable or
 * broken provider fails the tick with its own reason instead.
 *
 * @module kanban/hermes/backend
 */
import {
  DEFAULT_HERMES_BRAIN_MODEL,
  HERMES_TIERS,
  type HermesTier,
  type HermesTokenUsage,
  type HermesTransportClaim,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import {
  resolveHermesTransport,
  type HermesModelSelection,
  type HermesTransport,
} from "@t3tools/shared/hermesTransport";

export { HERMES_TIERS, resolveHermesTransport, type HermesTier };
export type { HermesModelSelection, HermesTransport, HermesTransportClaim };

/** Chain default when the board settings carry no model. */
export const HERMES_MODEL = DEFAULT_HERMES_BRAIN_MODEL;

const HERMES_CURSOR_MODEL = "composer-2.5";
const HERMES_XAI_MODEL = "grok-4.5";
const CODEX_MODEL_LUNA = "gpt-5.6-luna";
const CODEX_MODEL_SOL = "gpt-5.6-sol";
const HERMES_CURSOR_TIER = HERMES_TIERS[0];
const HERMES_XAI_TIER = HERMES_TIERS[1];
const HERMES_CODEX_TIER = HERMES_TIERS[2];

/** ACP CLIs take a bare base-model id — `x-ai/grok-4.5` is `grok-4.5` there. */
export function toAcpModelId(model?: string | null): string {
  const value = (model ?? "").trim() || HERMES_MODEL;
  const segments = value.split("/");
  return segments[segments.length - 1] ?? value;
}

/** The model a tier asks for, as that transport spells it. */
export function tierModelId(tier: HermesTier, model?: string | null): string {
  const value = (model ?? "").trim() || HERMES_MODEL;
  if (tier === HERMES_TIERS[3]) return value;
  if (tier === HERMES_CURSOR_TIER) return HERMES_CURSOR_MODEL;
  if (tier === HERMES_XAI_TIER) return HERMES_XAI_MODEL;

  const base = toAcpModelId(value);
  return tier === HERMES_CODEX_TIER && base === CODEX_MODEL_LUNA
    ? CODEX_MODEL_LUNA
    : CODEX_MODEL_SOL;
}

export type HermesBackendErrorKind =
  /** The provider could not serve at all — missing binary, no key, timeout, 5xx. */
  | "unavailable"
  /** The provider answered and the answer was unusable. */
  | "bad-response";

export class HermesBackendError extends Error {
  readonly kind: HermesBackendErrorKind;
  readonly tier: HermesTier;

  constructor(input: {
    tier: HermesTier;
    kind: HermesBackendErrorKind;
    message: string;
    cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "HermesBackendError";
    this.kind = input.kind;
    this.tier = input.tier;
  }
}

/** Why a tier cannot serve, for the settings panel. Never carries a key. */
export type HermesTierAvailability = {
  readonly tier: HermesTier;
  readonly available: boolean;
  readonly detail: string;
};

/**
 * One completion. `usage` is present only when the transport reports it — the
 * ACP CLIs do not, and an invented number would make the spend log a liar.
 */
export type HermesCompletion = {
  readonly text: string;
  readonly usage?: HermesTokenUsage;
};

/** Base64, no data-URL prefix — the same shape a canvas message stores. */
export type HermesImage = {
  readonly mediaType: string;
  readonly data: string;
};

export type HermesMessage = {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
  /**
   * Pictures riding this turn. Only the OpenRouter tier can carry them; the ACP
   * CLIs get the text alone, which is why the prompt names every attachment in
   * prose rather than relying on the model seeing it.
   */
  readonly images?: ReadonlyArray<HermesImage>;
};

export interface HermesBackend {
  readonly tier: HermesTier;
  /**
   * Driver kind whose configured instances this transport runs. A backend that
   * declares neither this nor `modelPrefix` can never be selected — resolution
   * reads these, so a new driver is a new backend, not an edit to a map.
   */
  readonly driver?: ProviderDriverKind;
  /** Model-slug prefix this transport claims whatever instance is picked. */
  readonly modelPrefix?: string;
  readonly available: () => Promise<HermesTierAvailability>;
  readonly complete: (input: {
    system: string;
    user: string;
    model?: string | undefined;
  }) => Promise<HermesCompletion>;
  /**
   * Present when the transport can carry a message history: HTTP tiers re-send
   * it every ask, CLI tiers hold it in a live session and are sent only the
   * newest turn. A tier without it serves the stateless prompt instead — that
   * is the fallback path, not an error.
   */
  readonly completeConversation?: (input: {
    messages: ReadonlyArray<HermesMessage>;
    model?: string | undefined;
  }) => Promise<HermesCompletion>;
  /**
   * Drop the live CLI session and the process behind it. Eviction calls this —
   * the next tick then opens a fresh session and sends the whole history back —
   * and so do a settings change and shutdown. A transport that holds no
   * session does not implement it.
   */
  readonly endSession?: () => Promise<void>;
  /** The live session's id, for the conversation record. Null when none is open. */
  readonly sessionId?: () => string | null;
  /**
   * Reattach to the session a previous process left running, read back from the
   * conversation record on boot. Ignored once this process holds one of its own.
   */
  readonly adoptSession?: (input: { readonly id: string; readonly model: string }) => void;
}

/**
 * End every live CLI session in this list. The one way a session dies:
 * eviction, a changed transport, a conversation reset, and layer shutdown all
 * come through here.
 */
export async function endHermesSessions(
  backends: ReadonlyArray<Pick<HermesBackend, "endSession">>,
): Promise<void> {
  await Promise.all(
    backends.map(async (backend) => {
      // A session that cannot be closed is already gone; the next ask opens one.
      await backend.endSession?.().catch(() => undefined);
    }),
  );
}

export type HermesAttempt = {
  readonly tier: HermesTier;
  readonly outcome: "served" | "unavailable" | "bad-response" | "skipped";
  readonly detail: string;
  /** Wall clock for this tier, availability probe included. */
  readonly durationMs: number;
  readonly usage?: HermesTokenUsage;
};

export type HermesBackendResult = {
  /** The provider, when it answered at all; null when it never got that far. */
  readonly tier: HermesTier | null;
  readonly text: string | null;
  readonly usage: HermesTokenUsage | null;
  readonly attempts: ReadonlyArray<HermesAttempt>;
  readonly error: HermesBackendError | null;
  /** How the provider was asked; null when it did not serve. */
  readonly mode: "conversation" | "stateless" | null;
};

export type HermesBackendRunInput = {
  readonly backends: ReadonlyArray<HermesBackend>;
  /** The one provider to ask. Nothing else is tried. */
  readonly provider: HermesTier;
  readonly system: string;
  /** The stateless ask, for a provider that cannot carry history. */
  readonly user: string;
  /**
   * The conversational ask: prior turns plus this tick's delta. A backend with
   * `completeConversation` gets this; every other tier gets `user`.
   */
  readonly conversation?: {
    readonly history: ReadonlyArray<HermesMessage>;
    readonly user: string;
    /** Pictures a human or a thread sent this tick, attached to the ask. */
    readonly images?: ReadonlyArray<HermesImage>;
  };
  readonly model?: string | undefined;
  /** Test seam for attempt timing. */
  readonly now?: () => number;
};

function toBackendError(tier: HermesTier, cause: unknown): HermesBackendError {
  if (cause instanceof HermesBackendError) return cause;
  return new HermesBackendError({
    tier,
    kind: "unavailable",
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

/**
 * Ask the chosen provider once. A provider that cannot serve, or has no backend
 * wired up, ends here — nothing else is tried on its behalf.
 */
export async function runHermesBackend(input: HermesBackendRunInput): Promise<HermesBackendResult> {
  const tier = input.provider;
  const now = input.now ?? (() => Date.now());
  const backend = input.backends.find((entry) => entry.tier === tier);
  if (!backend) {
    const error = new HermesBackendError({
      tier,
      kind: "unavailable",
      message: `no ${tier} backend is wired up on this box`,
    });
    return {
      tier: null,
      text: null,
      usage: null,
      attempts: [{ tier, outcome: "unavailable", detail: error.message, durationMs: 0 }],
      error,
      mode: null,
    };
  }

  // Timed from the probe, not from `complete`: a provider that takes ten
  // seconds to decide it is unavailable is exactly the cost worth seeing.
  const startedMs = now();
  const elapsed = () => Math.max(0, now() - startedMs);
  const availability = await backend.available().catch(
    (cause: unknown): HermesTierAvailability => ({
      tier,
      available: false,
      detail: cause instanceof Error ? cause.message : String(cause),
    }),
  );
  if (!availability.available) {
    return {
      tier: null,
      text: null,
      usage: null,
      attempts: [
        { tier, outcome: "unavailable", detail: availability.detail, durationMs: elapsed() },
      ],
      error: new HermesBackendError({ tier, kind: "unavailable", message: availability.detail }),
      mode: null,
    };
  }

  const conversation = input.conversation;
  const completeConversation = conversation ? backend.completeConversation : undefined;
  try {
    const completion =
      conversation && completeConversation
        ? await completeConversation({
            messages: [
              { role: "system", content: input.system },
              ...conversation.history,
              {
                role: "user",
                content: conversation.user,
                ...(conversation.images && conversation.images.length > 0
                  ? { images: conversation.images }
                  : {}),
              },
            ],
            model: input.model,
          })
        : await backend.complete({
            system: input.system,
            user: input.user,
            model: input.model,
          });
    const usage = completion.usage ?? null;
    const mode = completeConversation ? ("conversation" as const) : ("stateless" as const);
    return {
      tier,
      text: completion.text,
      usage,
      attempts: [
        {
          tier,
          outcome: "served",
          detail: "ok",
          durationMs: elapsed(),
          ...(usage ? { usage } : {}),
        },
      ],
      error: null,
      mode,
    };
  } catch (cause) {
    const error = toBackendError(tier, cause);
    const answered = error.kind === "bad-response";
    return {
      tier: answered ? tier : null,
      text: null,
      usage: null,
      attempts: [
        {
          tier,
          outcome: answered ? "bad-response" : "unavailable",
          detail: error.message,
          durationMs: elapsed(),
        },
      ],
      error,
      mode: null,
    };
  }
}

/** Add two usage rows; a tier that reported nothing contributes nothing. */
export function addUsage(
  left: HermesTokenUsage | null,
  right: HermesTokenUsage | null,
): HermesTokenUsage | null {
  if (!left) return right;
  if (!right) return left;
  const usd = (left.usd ?? 0) + (right.usd ?? 0);
  const reasoning = (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0);
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
    ...(left.usd === undefined && right.usd === undefined ? {} : { usd }),
    ...(right.generationId === undefined ? {} : { generationId: right.generationId }),
    ...(right.provider === undefined ? {} : { provider: right.provider }),
  };
}

/**
 * The claims of the backends this box has wired up. The only routing table —
 * `resolveHermesTransport` (shared, so the picker gives the same answer) reads
 * nothing else.
 */
export function hermesTransportClaims(
  backends: ReadonlyArray<Pick<HermesBackend, "tier" | "driver" | "modelPrefix">>,
): ReadonlyArray<HermesTransportClaim> {
  return backends.map((backend) => ({
    tier: backend.tier,
    driver: backend.driver ?? null,
    modelPrefix: backend.modelPrefix ?? null,
  }));
}
