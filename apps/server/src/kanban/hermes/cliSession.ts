/**
 * One live CLI session per Hermes transport.
 *
 * A tick used to spawn a whole CLI, ask one question and tear it down, so the
 * brain had no memory of its own between ticks and the conversation it kept was
 * never sent anywhere. Here the session is opened once and kept: the first ask
 * carries the system prompt and every turn the history holds, and each later
 * ask carries only the newest turn, because the CLI is still holding the rest.
 *
 * Losing that session is memory loss, so it is never shrugged off. A process
 * that died is reattached by session id; a resume that fails, or comes back as
 * a different session, is recorded as a degradation and answered with a fresh
 * session and a full re-send.
 *
 * @module kanban/hermes/cliSession
 */
import { recordDegradation } from "../../health/incidentLog.ts";
import {
  HermesBackendError,
  type HermesBackend,
  type HermesMessage,
  type HermesTier,
} from "./backend.ts";

/** A started CLI session: what to call it, how to ask it, how to end it. */
export type HermesCliSessionHandle = {
  readonly sessionId: string;
  readonly prompt: (text: string) => Promise<string>;
  readonly close: () => Promise<void>;
};

export type HermesCliOpenInput = {
  readonly model: string;
  /**
   * Reattach to this session instead of starting one. The handle must come
   * back carrying this same id — a CLI that quietly started a new session
   * resumed nothing, and is treated as a failed resume.
   */
  readonly resumeSessionId?: string;
};

/** What a CLI-backed transport contributes on top of its stateless `complete`. */
export type HermesCliSession = Required<
  Pick<HermesBackend, "completeConversation" | "endSession" | "sessionId" | "adoptSession">
>;

/** System and user, the way every Hermes CLI prompt is spelled. */
export function hermesPromptText(system: string, user: string): string {
  return `${system}\n\n---\n\n${user}`;
}

/** Marks a retained assistant turn in a re-send, so the CLI can tell it apart. */
const REPLY_HEADER = "## YOUR PREVIOUS REPLY";

/**
 * Everything a fresh session has to be told: the system prompt, every retained
 * turn, and the new ask. Only sent when there is no session to talk to.
 */
function fullText(messages: ReadonlyArray<HermesMessage>): string {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const rest = messages
    .filter((message) => message.role !== "system")
    .map((message) =>
      message.role === "assistant" ? `${REPLY_HEADER}\n${message.content}` : message.content,
    )
    .join("\n\n");
  return hermesPromptText(system, rest);
}

export function makeHermesCliSession(input: {
  readonly tier: HermesTier;
  readonly open: (open: HermesCliOpenInput) => Promise<HermesCliSessionHandle>;
}): HermesCliSession {
  const tier = input.tier;
  let live: { readonly handle: HermesCliSessionHandle; readonly model: string } | null = null;
  let sessionId: string | null = null;
  let sessionModel: string | null = null;

  const closeQuietly = async (handle: HermesCliSessionHandle): Promise<void> => {
    await handle.close().catch(() => undefined);
  };

  const endSession = async (): Promise<void> => {
    const current = live;
    live = null;
    sessionId = null;
    sessionModel = null;
    if (current) await closeQuietly(current.handle);
  };

  const openFresh = async (model: string, text: string): Promise<string> => {
    const handle = await input.open({ model });
    live = { handle, model };
    sessionId = handle.sessionId;
    sessionModel = model;
    return handle.prompt(text);
  };

  const send = async (model: string, delta: string, full: string): Promise<string> => {
    // A different model is a different brain; its session carries the wrong
    // history and the wrong price.
    if (live && live.model !== model) await endSession();
    if (sessionModel !== null && sessionModel !== model) {
      sessionId = null;
      sessionModel = null;
    }

    if (live) {
      const current = live;
      try {
        return await current.handle.prompt(delta);
      } catch (cause) {
        // The CLI is gone. The session id is what gets its memory back.
        live = null;
        await closeQuietly(current.handle);
        // endSession already cleared the retained id — this close was
        // intentional (wall-clock abort, eviction, shutdown). Do not open a
        // replacement under the abandoned ask; that is how overlapping
        // `codex app-server` scopes pile up after a tick lock releases.
        if (sessionId === null) throw cause;
      }
    }

    if (sessionId !== null) {
      const target = sessionId;
      let resumed: HermesCliSessionHandle | null = null;
      let failure: string | null = null;
      try {
        resumed = await input.open({ model, resumeSessionId: target });
      } catch (cause) {
        failure = cause instanceof Error ? cause.message : String(cause);
      }
      if (resumed && resumed.sessionId === target) {
        live = { handle: resumed, model };
        return await resumed.prompt(delta);
      }
      if (resumed) {
        failure = `the CLI answered as session ${resumed.sessionId}`;
        await closeQuietly(resumed);
      }
      sessionId = null;
      sessionModel = null;
      recordDegradation({
        id: "hermes.cliSession",
        title: "Hermes lost its CLI session",
        detail:
          `${tier} could not resume session ${target}: ${failure ?? "unknown"} — ` +
          "a fresh session was opened and the whole retained history re-sent",
      });
    }

    return await openFresh(model, full);
  };

  const completeConversation: HermesCliSession["completeConversation"] = async (ask) => {
    const model = (ask.model ?? "").trim();
    const delta = ask.messages.at(-1)?.content ?? "";
    const text = await send(model, delta, fullText(ask.messages)).catch((cause: unknown) => {
      if (cause instanceof HermesBackendError) throw cause;
      throw new HermesBackendError({
        tier,
        kind: "unavailable",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
    });
    if (!text.trim()) {
      throw new HermesBackendError({
        tier,
        kind: "bad-response",
        message: `${tier} returned empty output`,
      });
    }
    // A CLI session reports no token counts, so this tier's spend stays
    // knowable only as the attempt's wall clock.
    return { text };
  };

  return {
    completeConversation,
    endSession,
    sessionId: () => sessionId,
    // Restart recovery: the id comes back from the conversation record before
    // any tick runs, so the first send reattaches instead of re-sending. A live
    // session outranks it — that one is this process's own.
    adoptSession: (adopted) => {
      if (live) return;
      sessionId = adopted.id;
      sessionModel = adopted.model;
    },
  };
}
