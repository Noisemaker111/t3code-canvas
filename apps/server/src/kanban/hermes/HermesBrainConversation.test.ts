import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { DEFAULT_BOARD_SETTINGS, ProviderDriverKind, type BoardSettings } from "@t3tools/contracts";

import {
  bindHealthIncidentLog,
  readHealthIncidents,
  unbindHealthIncidentLog,
} from "../../health/incidentLog.ts";
import type { HermesBackend, HermesMessage } from "./backend.ts";
import { makeHermesCliSession, type HermesCliOpenInput } from "./cliSession.ts";
import {
  bindHermesConversation,
  hermesConversationPath,
  unbindHermesConversation,
} from "./conversationStore.ts";
import { makeFakeBoardApi, makeFakeCard } from "./fakeBoardApi.ts";
import {
  hermesConversationStatus,
  resetHermesBrainState,
  resetHermesConversation,
  restoreHermesConversation,
  runHermesHeartbeat,
  runOneTick,
} from "./HermesBrain.ts";

const settings = (patch: Partial<BoardSettings> = {}): BoardSettings => ({
  ...DEFAULT_BOARD_SETTINGS,
  hermesBrainInstanceId: "opencode",
  hermesBrainModel: "openrouter/x-ai/grok-4.5",
  ...patch,
});

/** A Draft only a model can read, so every tick has a judgment item. */
const rawDraft = (id = "raw") =>
  makeFakeCard({ id, at: "prompts", body: "make the toast stop flashing" });

const NOTE_PROGRAM = "```js\nawait board.note({ text: 'thinking' });\n```";

/** OpenRouter-shaped fake: carries history, records every ask. */
const conversational = (program = NOTE_PROGRAM) => {
  const backend = {
    tier: "openrouter" as const,
    modelPrefix: "openrouter/",
    conversations: [] as HermesMessage[][],
    statelessUsers: [] as string[],
    available: async () => ({ tier: "openrouter" as const, available: true, detail: "ok" }),
    complete: async (input: { user: string }) => {
      backend.statelessUsers.push(input.user);
      return { text: program };
    },
    completeConversation: async (input: { messages: ReadonlyArray<HermesMessage> }) => {
      backend.conversations.push([...input.messages]);
      return { text: program };
    },
  };
  return backend;
};

/** ACP-shaped fake: no history transport, records the stateless prompt. */
const stateless = (tier: HermesBackend["tier"], program = NOTE_PROGRAM) => {
  const backend = {
    tier,
    driver: ProviderDriverKind.make(tier === "xai" ? "grok" : tier),
    users: [] as string[],
    available: async () => ({ tier, available: true, detail: "ok" }),
    complete: async (input: { user: string }) => {
      backend.users.push(input.user);
      return { text: program };
    },
  };
  return backend;
};

type CliBackedState = {
  opens: HermesCliOpenInput[];
  prompts: string[];
  closed: string[];
  seq: number;
};

/**
 * CLI-shaped fake: one live session per open, every ask recorded. Pass a prior
 * `state` to model a server restart — the agent kept running, the backend
 * holding it did not.
 */
const cliBacked = (
  program = NOTE_PROGRAM,
  existing?: CliBackedState,
  tier: "cursor" | "xai" = "cursor",
) => {
  const state: CliBackedState = existing ?? {
    opens: [],
    prompts: [],
    closed: [],
    seq: 0,
  };
  const open = async (input: HermesCliOpenInput) => {
    state.opens.push(input);
    state.seq += 1;
    const sessionId = input.resumeSessionId ?? `s${state.seq}`;
    return {
      sessionId,
      prompt: async (text: string) => {
        state.prompts.push(text);
        return program;
      },
      close: async () => {
        state.closed.push(sessionId);
      },
    };
  };
  return {
    tier,
    driver: ProviderDriverKind.make(tier === "xai" ? "grok" : "cursor"),
    state,
    available: async () => ({ tier, available: true, detail: "ok" }),
    complete: async () => ({ text: program }),
    ...makeHermesCliSession({ tier, open }),
  };
};

const cliSettings = () =>
  settings({ hermesBrainInstanceId: "cursor", hermesBrainModel: "grok-4.5" });

let baseDir: string;

beforeEach(() => {
  resetHermesBrainState();
  baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hermes-brain-conv-"));
  bindHermesConversation(baseDir);
  bindHealthIncidentLog(baseDir);
});

afterEach(() => {
  unbindHermesConversation();
  unbindHealthIncidentLog();
  resetHermesBrainState();
  NodeFS.rmSync(baseDir, { recursive: true, force: true });
});

describe("Hermes conversation across ticks", () => {
  it("second tick sends the delta on top of the first tick's turns, not a rebuilt snapshot", async () => {
    const { api } = makeFakeBoardApi({ cards: [rawDraft()] });
    const backend = conversational();
    const deps = { api, backends: [backend], boardSettings: async () => settings() };

    const first = await runOneTick(deps);
    const second = await runOneTick(deps);

    expect(backend.conversations).toHaveLength(2);
    const firstAsk = backend.conversations[0] ?? [];
    const secondAsk = backend.conversations[1] ?? [];
    // First turn carries the full snapshot.
    expect(firstAsk.at(-1)?.content).toContain("## POLICY");
    // The second ask carries the first tick's program and results as history…
    const history = secondAsk.map((message) => message.content).join("\n");
    expect(history).toContain("board.note({ text: 'thinking' })");
    expect(history).toContain("## RESULT");
    expect(history).toContain("note");
    // …and its new user turn is a delta, not the world again.
    const delta = secondAsk.at(-1)?.content ?? "";
    expect(delta).toContain("## BOARD CHANGES");
    expect(delta).not.toContain("## POLICY");
    expect(delta.length).toBeLessThan((firstAsk.at(-1)?.content ?? "").length);
    // The tick log can price history vs delta.
    expect(second.cost?.historyTokens ?? 0).toBeGreaterThan(0);
    expect(second.cost?.deltaTokens ?? 0).toBeGreaterThan(0);
    expect(first.cost?.deltaTokens ?? 0).toBeGreaterThan(second.cost?.deltaTokens ?? 0);
  });

  it("survives a restart: restored history keeps the pre-restart turns", async () => {
    const { api } = makeFakeBoardApi({ cards: [rawDraft()] });
    const backend = conversational();
    const deps = { api, backends: [backend], boardSettings: async () => settings() };
    await runOneTick(deps);

    resetHermesBrainState();
    restoreHermesConversation();
    expect(hermesConversationStatus().turns).toBe(3);

    await runOneTick(deps);
    const ask = backend.conversations.at(-1) ?? [];
    expect(ask.map((message) => message.content).join("\n")).toContain("## RESULT");
    expect(ask.at(-1)?.content).toContain("## BOARD CHANGES");
  });

  it("falls back to a stateless full prompt when the provider carries no history, then tells the conversation", async () => {
    const { api } = makeFakeBoardApi({ cards: [rawDraft()] });
    const openrouter = conversational();
    const cursor = stateless("cursor");
    const boardSettings = async () => settings();

    await runOneTick({ api, backends: [openrouter], boardSettings });
    await runOneTick({
      api,
      backends: [cursor],
      boardSettings: async () =>
        settings({ hermesBrainInstanceId: "cursor", hermesBrainModel: "grok-4.5" }),
    });

    // The ACP tier got the whole world, no history.
    expect(cursor.users).toHaveLength(1);
    expect(cursor.users[0]).toContain("## POLICY");
    // The conversation recorded the fallback tick's calls as a result turn.
    await runOneTick({ api, backends: [openrouter], boardSettings });
    const ask = openrouter.conversations.at(-1) ?? [];
    expect(ask.map((message) => message.content).join("\n")).toContain("stateless fallback");
  });

  it("a corrupt file reseeds a fresh conversation instead of failing a tick", async () => {
    NodeFS.writeFileSync(String(hermesConversationPath()), "{torn", "utf8");
    restoreHermesConversation();
    expect(hermesConversationStatus().turns).toBe(0);

    const { api } = makeFakeBoardApi({ cards: [rawDraft()] });
    const backend = conversational();
    const tick = await runOneTick({
      api,
      backends: [backend],
      boardSettings: async () => settings(),
    });

    expect(tick.error).toBeNull();
    expect(backend.conversations[0]?.at(-1)?.content).toContain("## POLICY");
  });

  it("keeps an unresolved prompt actionable across heartbeats", async () => {
    const { api } = makeFakeBoardApi({ cards: [rawDraft()] });
    // A true no-op leaves the prompt unresolved. The next heartbeat must still
    // ask for a decision instead of silently treating the card as handled.
    const backend = conversational("```js\nundefined;\n```");
    const deps = { api, backends: [backend], boardSettings: async () => settings() };

    const first = await runHermesHeartbeat(deps, new Date("2026-01-01T00:00:00.000Z"));
    const turnsAfterFirst = hermesConversationStatus().turns;
    const second = await runHermesHeartbeat(deps, new Date("2026-01-01T00:01:00.000Z"));

    expect(first.ranModel).toBe(true);
    expect(second.ranModel).toBe(true);
    expect(backend.conversations).toHaveLength(2);
    expect(hermesConversationStatus().turns).toBeGreaterThan(turnsAfterFirst);
  });

  it("a dry run reads the conversation without growing it", async () => {
    const { api } = makeFakeBoardApi({ cards: [rawDraft()] });
    const backend = conversational();
    const deps = { api, backends: [backend], boardSettings: async () => settings() };
    await runOneTick(deps);
    const before = hermesConversationStatus().turns;

    await runOneTick(deps, { recordOnly: true });

    expect(hermesConversationStatus().turns).toBe(before);
  });

  it("reset wipes the history and the next tick starts from a snapshot", async () => {
    const { api } = makeFakeBoardApi({ cards: [rawDraft()] });
    const backend = conversational();
    const deps = { api, backends: [backend], boardSettings: async () => settings() };
    await runOneTick(deps);

    await resetHermesConversation();
    expect(hermesConversationStatus().turns).toBe(0);

    await runOneTick(deps);
    expect(backend.conversations.at(-1)?.at(-1)?.content).toContain("## POLICY");
  });
});

const TOUCH_PROGRAM = "```js\nawait board.archiveCard({ id: 'raw', archived: false });\n```";

/** Realistically sized turns, so a history is worth the snapshot that replaces it. */
const BULKY_PROGRAM = [
  "```js",
  `// ${"reasoning ".repeat(400)}`,
  "await board.archiveCard({ id: 'raw', archived: false });",
  "```",
].join("\n");

describe("Hermes conversation memory", () => {
  it("replays the card's own past calls into the next prompt", async () => {
    const { api } = makeFakeBoardApi({ cards: [rawDraft()] });
    const backend = conversational(TOUCH_PROGRAM);
    const deps = { api, backends: [backend], boardSettings: async () => settings() };

    await runOneTick(deps);
    await runOneTick(deps);

    const delta = backend.conversations.at(-1)?.at(-1)?.content ?? "";
    expect(delta).toContain("## ALREADY TRIED");
    expect(delta).toContain("- raw");
    expect(delta).toContain("archiveCard → ok");
    expect(hermesConversationStatus().journalEntries).toBe(2);
  });

  it("cuts the history when the board settles, not on a counter", async () => {
    const { api, state } = makeFakeBoardApi({ cards: [rawDraft()] });
    const backend = conversational(BULKY_PROGRAM);
    const deps = { api, backends: [backend], boardSettings: async () => settings() };

    // Build a history worth dropping while the card is still undecided.
    for (let index = 0; index < 12; index += 1) await runOneTick(deps);
    const busy = hermesConversationStatus();
    expect(busy.turns).toBe(36);
    expect(busy.lastEvictionAt).toBeNull();

    // The card is decided; nothing needs a decision any more.
    state.cards = [makeFakeCard({ id: "raw", at: "done", prepStatus: "ready" })];
    await runOneTick(deps);

    const settled = hermesConversationStatus();
    expect(settled.turns).toBe(0);
    expect(settled.lastEvictionReason).toBe("settled");
    // Nothing was asked to remember anything — compaction used to be a
    // completion of the whole transcript, so the stateless path stays untouched.
    expect(backend.statelessUsers).toEqual([]);
    expect(backend.conversations).toHaveLength(12);
  });

  it("holds the history through a decision, then re-reads the board after the cut", async () => {
    const { api, state } = makeFakeBoardApi({ cards: [rawDraft()] });
    const backend = conversational(BULKY_PROGRAM);
    const deps = { api, backends: [backend], boardSettings: async () => settings() };

    for (let index = 0; index < 12; index += 1) await runOneTick(deps);
    state.cards = [makeFakeCard({ id: "raw", at: "done", prepStatus: "ready" })];
    await runOneTick(deps);

    // A new card re-opens the queue; the next ask is a snapshot, re-derived.
    state.cards = [
      makeFakeCard({ id: "raw", at: "done", prepStatus: "ready" }),
      rawDraft("second"),
    ];
    await runOneTick(deps);

    const ask = backend.conversations.at(-1) ?? [];
    // No retained turns — just the system prompt and a freshly re-read board.
    expect(ask.filter((message) => message.role !== "system")).toHaveLength(1);
    expect(ask.at(-1)?.content).toContain("## POLICY");
    expect(ask.map((message) => message.content).join("\n")).not.toContain("BOARD MEMORY");
    // What a re-read cannot recover came through the cut.
    expect(hermesConversationStatus().journalEntries).toBeGreaterThan(0);
  });

  it("keeps one CLI session across ticks and sends it only the delta", async () => {
    const { api } = makeFakeBoardApi({ cards: [rawDraft()] });
    const backend = cliBacked();
    const deps = { api, backends: [backend], boardSettings: async () => cliSettings() };

    await runOneTick(deps);
    await runOneTick(deps);

    expect(backend.state.opens).toEqual([{ model: "composer-2.5" }]);
    expect(backend.state.prompts).toHaveLength(2);
    expect(backend.state.prompts[0]).toContain("## POLICY");
    expect(backend.state.prompts[1]).toContain("## BOARD CHANGES");
    expect(backend.state.prompts[1]).not.toContain("## POLICY");
  });

  it("reattaches to the session it left running when the server restarts", async () => {
    const { api } = makeFakeBoardApi({ cards: [rawDraft()] });
    const first = cliBacked();
    await runOneTick({ api, backends: [first], boardSettings: async () => cliSettings() });

    // The process is gone; the agent and the conversation file are not.
    const restarted = cliBacked(NOTE_PROGRAM, first.state);
    resetHermesBrainState();
    restoreHermesConversation([restarted]);
    await runOneTick({ api, backends: [restarted], boardSettings: async () => cliSettings() });

    expect(restarted.state.opens).toEqual([
      { model: "composer-2.5" },
      { model: "composer-2.5", resumeSessionId: "s1" },
    ]);
    expect(restarted.state.prompts[1]).toContain("## BOARD CHANGES");
    expect(restarted.state.prompts[1]).not.toContain("## POLICY");
    expect(degradations()).toHaveLength(0);
  });

  it("does not reattach across a restart that changed the model", async () => {
    const { api } = makeFakeBoardApi({ cards: [rawDraft()] });
    const first = cliBacked();
    await runOneTick({ api, backends: [first], boardSettings: async () => cliSettings() });

    const restarted = cliBacked(NOTE_PROGRAM, first.state, "xai");
    resetHermesBrainState();
    restoreHermesConversation([restarted]);
    const moved = async () =>
      settings({ hermesBrainInstanceId: "grok", hermesBrainModel: "grok-4.5" });
    await runOneTick({ api, backends: [restarted], boardSettings: moved });

    // A session under another native provider/model holds the wrong history:
    // open fresh and send the full snapshot.
    expect(restarted.state.opens[1]).toEqual({ model: "grok-4.5" });
    expect(restarted.state.prompts[1]).toContain("## POLICY");
  });

  it("eviction drops the CLI session and the next tick opens a fresh one with the snapshot", async () => {
    const { api, state } = makeFakeBoardApi({ cards: [rawDraft()] });
    const backend = cliBacked(BULKY_PROGRAM);
    const deps = { api, backends: [backend], boardSettings: async () => cliSettings() };

    for (let index = 0; index < 12; index += 1) await runOneTick(deps);
    expect(backend.state.opens).toHaveLength(1);
    expect(backend.state.closed).toEqual([]);

    // The card is decided; the settled history and the session go together.
    state.cards = [makeFakeCard({ id: "raw", at: "done", prepStatus: "ready" })];
    await runOneTick(deps);
    expect(hermesConversationStatus().lastEvictionReason).toBe("settled");
    expect(backend.state.closed).toEqual(["s1"]);

    state.cards = [
      makeFakeCard({ id: "raw", at: "done", prepStatus: "ready" }),
      rawDraft("second"),
    ];
    await runOneTick(deps);

    expect(backend.state.opens).toEqual([{ model: "composer-2.5" }, { model: "composer-2.5" }]);
    expect(backend.state.prompts.at(-1)).toContain("## POLICY");
  });

  it("keeps the journal across a restart that reseeds the turns", async () => {
    const { api } = makeFakeBoardApi({ cards: [rawDraft()] });
    const backend = conversational(TOUCH_PROGRAM);
    const deps = { api, backends: [backend], boardSettings: async () => settings() };
    await runOneTick(deps);

    // A torn file loses the turns; the journal line still parses.
    NodeFS.appendFileSync(String(hermesConversationPath()), "{torn\n", "utf8");
    resetHermesBrainState();
    restoreHermesConversation();

    const status = hermesConversationStatus();
    expect(status.turns).toBe(0);
    expect(status.journalEntries).toBe(1);
  });
});
/** A CLI that can be killed, resumed, or made to lose the session entirely. */
function fakeCli(reply = "ok") {
  const state = {
    opens: [] as HermesCliOpenInput[],
    prompts: [] as { readonly sessionId: string; readonly text: string }[],
    closed: [] as string[],
    dead: new Set<string>(),
    seq: 0,
    resumeFails: false,
    /** The session id a resume comes back as — a CLI that silently restarted. */
    resumeAs: null as string | null,
  };
  const handle = (sessionId: string) => ({
    sessionId,
    prompt: async (text: string) => {
      if (state.dead.has(sessionId)) throw new Error(`${sessionId} is gone`);
      state.prompts.push({ sessionId, text });
      return reply;
    },
    close: async () => {
      state.closed.push(sessionId);
    },
  });
  const open = async (input: HermesCliOpenInput) => {
    state.opens.push(input);
    if (input.resumeSessionId !== undefined) {
      if (state.resumeFails) throw new Error("session/load failed: unknown session");
      const resumed = state.resumeAs ?? input.resumeSessionId;
      state.dead.delete(resumed);
      return handle(resumed);
    }
    state.seq += 1;
    return handle(`s${state.seq}`);
  };
  return { state, open };
}

const system: HermesMessage = { role: "system", content: "SYSTEM" };
const user = (content: string): HermesMessage => ({ role: "user", content });
const assistant = (content: string): HermesMessage => ({ role: "assistant", content });

const FIRST = [system, user("SNAPSHOT")];
const SECOND = [system, user("SNAPSHOT"), assistant("PROGRAM"), user("RESULT"), user("DELTA")];

const degradations = () =>
  readHealthIncidents(20).filter((incident) => incident.id === "degraded.hermes.cliSession");

describe("Hermes CLI session", () => {
  it("opens one session and sends only the new turn on every later ask", async () => {
    const cli = fakeCli();
    const session = makeHermesCliSession({ tier: "cursor", open: cli.open });

    await session.completeConversation({ messages: FIRST, model: "grok-4.5" });
    await session.completeConversation({ messages: SECOND, model: "grok-4.5" });

    expect(cli.state.opens).toEqual([{ model: "grok-4.5" }]);
    expect(cli.state.prompts.map((prompt) => prompt.sessionId)).toEqual(["s1", "s1"]);
    expect(cli.state.prompts[0]?.text).toBe("SYSTEM\n\n---\n\nSNAPSHOT");
    expect(cli.state.prompts[1]?.text).toBe("DELTA");
    expect(degradations()).toHaveLength(0);
  });

  it("resumes by session id when the process died, and still sends only the delta", async () => {
    const cli = fakeCli();
    const session = makeHermesCliSession({ tier: "cursor", open: cli.open });
    await session.completeConversation({ messages: FIRST, model: "grok-4.5" });

    cli.state.dead.add("s1");
    await session.completeConversation({ messages: SECOND, model: "grok-4.5" });

    expect(cli.state.opens[1]).toEqual({ model: "grok-4.5", resumeSessionId: "s1" });
    expect(cli.state.prompts.at(-1)).toEqual({ sessionId: "s1", text: "DELTA" });
    // Memory survived, so nothing degraded.
    expect(degradations()).toHaveLength(0);
  });

  it("records a degradation and re-sends the whole history when the resume fails", async () => {
    const cli = fakeCli();
    const session = makeHermesCliSession({ tier: "cursor", open: cli.open });
    await session.completeConversation({ messages: FIRST, model: "grok-4.5" });

    cli.state.dead.add("s1");
    cli.state.resumeFails = true;
    await session.completeConversation({ messages: SECOND, model: "grok-4.5" });

    expect(cli.state.opens).toEqual([
      { model: "grok-4.5" },
      { model: "grok-4.5", resumeSessionId: "s1" },
      { model: "grok-4.5" },
    ]);
    const sent = cli.state.prompts.at(-1);
    expect(sent?.sessionId).toBe("s2");
    expect(sent?.text).toContain("SYSTEM");
    expect(sent?.text).toContain("SNAPSHOT");
    expect(sent?.text).toContain("PROGRAM");
    expect(sent?.text).toContain("DELTA");
    const incidents = degradations();
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.detail).toContain("could not resume session s1");
  });

  it("treats a resume that comes back as another session as a lost session", async () => {
    const cli = fakeCli();
    const session = makeHermesCliSession({ tier: "codex", open: cli.open });
    await session.completeConversation({ messages: FIRST, model: "gpt-5" });

    cli.state.dead.add("s1");
    cli.state.resumeAs = "other";
    await session.completeConversation({ messages: SECOND, model: "gpt-5" });

    expect(cli.state.closed).toContain("other");
    expect(degradations()[0]?.detail).toContain("the CLI answered as session other");
    expect(cli.state.prompts.at(-1)?.text).toContain("SNAPSHOT");
  });

  it("a changed model gets its own session, not the old one's history", async () => {
    const cli = fakeCli();
    const session = makeHermesCliSession({ tier: "cursor", open: cli.open });
    await session.completeConversation({ messages: FIRST, model: "grok-4.5" });

    await session.completeConversation({ messages: SECOND, model: "grok-4.1" });

    expect(cli.state.closed).toEqual(["s1"]);
    expect(cli.state.opens).toEqual([{ model: "grok-4.5" }, { model: "grok-4.1" }]);
    expect(cli.state.prompts.at(-1)?.text).toContain("SNAPSHOT");
    // A settings change is not memory loss — it is a different brain.
    expect(degradations()).toHaveLength(0);
  });

  it("endSession closes the CLI and forgets the id, so the next ask starts over", async () => {
    const cli = fakeCli();
    const session = makeHermesCliSession({ tier: "cursor", open: cli.open });
    await session.completeConversation({ messages: FIRST, model: "grok-4.5" });

    await session.endSession();
    await session.completeConversation({ messages: SECOND, model: "grok-4.5" });

    expect(cli.state.closed).toEqual(["s1"]);
    expect(cli.state.opens).toEqual([{ model: "grok-4.5" }, { model: "grok-4.5" }]);
    expect(cli.state.prompts.at(-1)?.sessionId).toBe("s2");
    expect(cli.state.prompts.at(-1)?.text).toContain("SNAPSHOT");
  });

  it("does not open a replacement CLI when endSession kills an in-flight prompt", async () => {
    const state = {
      opens: [] as HermesCliOpenInput[],
      prompts: 0,
      closed: [] as string[],
      seq: 0,
    };
    let killPrompt!: (cause: Error) => void;
    let prompted!: () => void;
    const sawPrompt = new Promise<void>((resolve) => {
      prompted = resolve;
    });
    const open = async (input: HermesCliOpenInput) => {
      state.opens.push(input);
      state.seq += 1;
      const sessionId = `s${state.seq}`;
      return {
        sessionId,
        prompt: () =>
          new Promise<string>((_resolve, reject) => {
            state.prompts += 1;
            killPrompt = reject;
            prompted();
          }),
        close: async () => {
          state.closed.push(sessionId);
        },
      };
    };
    const session = makeHermesCliSession({ tier: "codex", open });
    const ask = session.completeConversation({ messages: FIRST, model: "gpt-5.6-luna" });
    await sawPrompt;

    await session.endSession();
    killPrompt(new Error("Codex App Server process exited with code 0"));

    await expect(ask).rejects.toThrow(/exited with code 0/);
    expect(state.opens).toHaveLength(1);
    expect(state.closed).toEqual(["s1"]);
    expect(degradations()).toHaveLength(0);
  });

  it("an empty answer is a bad response, not an empty program", async () => {
    const cli = fakeCli("   ");
    const session = makeHermesCliSession({ tier: "xai", open: cli.open });

    await expect(
      session.completeConversation({ messages: FIRST, model: "grok-4.5" }),
    ).rejects.toThrow("xai returned empty output");
  });
});
