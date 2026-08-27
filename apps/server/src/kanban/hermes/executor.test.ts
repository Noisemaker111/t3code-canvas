import { describe, expect, it } from "@effect/vitest";

import { HermesProgramError, runHermesProgram, unwrapProgram } from "./executor.ts";
import { makeFakeBoardApi, makeFakeCard } from "./fakeBoardApi.ts";
import type { HermesMcpToolset } from "./mcpRegistry.ts";

const policy = {
  launchPrompts: true,
  stuckPrepMs: 120_000,
  autoFinishActive: true,
  autoMergeWhenGreen: true,
  prCheckGraceMs: 600_000,
  conflictReturn: true,
  stalledCardMs: 1_800_000,
  maxChecks: 10,
  maxSyncs: 3,
  review: { enabled: false, prompt: "review it" },
  helpers: { enabled: true, maxConcurrent: 2, timeoutMs: 900_000 },
};

describe("unwrapProgram", () => {
  it("strips a js fence", () => {
    expect(unwrapProgram("```js\nboard.advanceCard({ id: 'c1' })\n```")).toBe(
      "board.advanceCard({ id: 'c1' })",
    );
  });

  it("pulls the program out of surrounding prose", () => {
    expect(
      unwrapProgram("Here you go:\n\n```javascript\nawait board.note({ text: 'x' })\n```\nOk."),
    ).toBe("await board.note({ text: 'x' })");
  });

  it("passes an unfenced program through", () => {
    expect(unwrapProgram("  await board.note({ text: 'x' })  ")).toBe(
      "await board.note({ text: 'x' })",
    );
  });
});

describe("runHermesProgram", () => {
  it("records the verb and the primitives it drove", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "c1", at: "prompts", projectId: "proj-1", body: "do it" })],
    });

    const result = await runHermesProgram({
      api,
      policy,
      source: ["```js", "await board.advanceCard({ id: 'c1' });", "```"].join("\n"),
    });

    expect(result.error).toBeNull();
    expect(result.calls.map((call) => call.method)).toEqual([
      "advanceCard",
      "list",
      "launchActive",
    ]);
    expect(state.cards[0]?.at).toBe("active");
  });

  it("keeps the model's free-text note and lets the runtime own the beat", async () => {
    const { api } = makeFakeBoardApi({ cards: [] });

    const result = await runHermesProgram({
      api,
      policy,
      source: "await board.note({ text: 'c2 conflicts on PrPipeline.ts — needs you' });",
    });

    expect(result.note).toBe("c2 conflicts on PrPipeline.ts — needs you");
  });

  it("asks a blocking clarification through the durable Hermes chat", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "c1", title: "Add a tools hotbar button" })],
    });

    const result = await runHermesProgram({
      api,
      policy,
      source: [
        "await board.askUser({",
        "  cardId: 'c1',",
        "  question: 'Which project owns this hotbar?',",
        "  options: ['jgengine', 'agentgui', 'vps-code'],",
        "});",
      ].join("\n"),
    });

    expect(result.error).toBeNull();
    expect(result.replies).toEqual([
      [
        "I need one detail before I can continue “Add a tools hotbar button”:",
        "",
        "Which project owns this hotbar?",
        "",
        "Choices:",
        "- jgengine",
        "- agentgui",
        "- vps-code",
        "",
        "Reply with a choice or your own answer.",
      ].join("\n"),
    ]);
    expect(result.calls.map((call) => call.method)).toEqual(["askUser", "list"]);
    expect(state.cards[0]?.projectId).toBeNull();
  });

  it("refuses a verb whose guard does not hold, without throwing", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "c1", at: "active", threadId: "t1" })],
    });

    const result = await runHermesProgram({
      api,
      policy,
      source: [
        "const out = await board.structureCard({ id: 'c1', body: 'rewritten' });",
        "console.log(out.ok ? 'wrote' : out.reason);",
      ].join("\n"),
    });

    expect(result.error).toBeNull();
    expect(result.logs).toEqual(["card 'c1' is in active, not Prompts"]);
    expect(state.cards[0]?.body).toBe("");
  });

  it("record-only mode reads the real board but skips every write", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [makeFakeCard({ id: "c1", at: "prompts", projectId: "proj-1", body: "do it" })],
    });

    const result = await runHermesProgram({
      api,
      policy,
      recordOnly: true,
      source: "await board.advanceCard({ id: 'c1' });",
    });

    expect(result.recordOnly).toBe(true);
    expect(result.calls.at(-1)).toMatchObject({ method: "launchActive", skipped: true });
    expect(state.cards[0]?.at).toBe("prompts");
  });

  it("records a board error without killing the transcript", async () => {
    const { api } = makeFakeBoardApi({ cards: [] });

    const result = await runHermesProgram({
      api,
      policy,
      source: [
        "const out = await board.advanceCard({ id: 'nope' });",
        "console.log(out.reason);",
      ].join("\n"),
    });

    expect(result.error).toBeNull();
    expect(result.logs).toEqual(["card 'nope' is gone"]);
  });

  it("caps board calls per tick", async () => {
    const { api } = makeFakeBoardApi({ cards: [] });

    const result = await runHermesProgram({
      api,
      policy,
      maxCalls: 3,
      source: "for (let i = 0; i < 10; i++) { await board.note({ text: 'x' }) }",
    });

    expect(result.error).toMatch(/exceeded 3 board calls/);
    expect(result.calls).toHaveLength(3);
  });

  it("rejects a syntactically broken program at compile time", async () => {
    const { api } = makeFakeBoardApi({ cards: [] });

    await expect(
      runHermesProgram({ api, policy, source: "await board.note(" }),
    ).rejects.toBeInstanceOf(HermesProgramError);
  });

  it("exposes no require, fetch or process", async () => {
    const { api } = makeFakeBoardApi({ cards: [] });

    const result = await runHermesProgram({
      api,
      policy,
      source: [
        "const missing = [];",
        "for (const name of ['require', 'fetch', 'process', 'import']) {",
        "  if (typeof globalThis[name] !== 'undefined') missing.push(name);",
        "}",
        "console.log(missing.length === 0 ? 'sealed' : missing.join(','));",
      ].join("\n"),
    });

    expect(result.error).toBeNull();
    expect(result.logs).toEqual(["sealed"]);
  });

  it("reaches no board call the surface does not declare", async () => {
    const { api } = makeFakeBoardApi({ cards: [] });

    const result = await runHermesProgram({
      api,
      policy,
      source: [
        "const reachable = ['openPr', 'mergePr', 'syncPrBranch', 'heartbeat', 'list', 'boardSettings']",
        "  .filter((name) => typeof board[name] === 'function');",
        "console.log(reachable.join(',') || 'none');",
      ].join("\n"),
    });

    expect(result.logs).toEqual(["none"]);
  });

  it("stops a runaway program at the wall clock", async () => {
    const { api } = makeFakeBoardApi({ cards: [] });

    const result = await runHermesProgram({
      api,
      policy,
      timeoutMs: 50,
      source: "while (true) {}",
    });

    expect(result.error).toMatch(/timed out|exceeded/i);
  });

  it("structureCard can drop irrelevant attachments via keepAttachmentIds", async () => {
    const { api, state } = makeFakeBoardApi({
      cards: [
        makeFakeCard({
          id: "c1",
          at: "prompts",
          body: "fix the toast",
          attachments: [
            {
              id: "keep-me",
              kind: "image",
              name: "bug.png",
              mimeType: "image/png",
              sizeBytes: 12,
              include: true,
            },
            {
              id: "drop-me",
              kind: "video",
              name: "noise.webm",
              mimeType: "video/webm",
              sizeBytes: 40,
              include: true,
            },
          ],
        }),
      ],
    });

    const result = await runHermesProgram({
      api,
      policy,
      source: [
        "```js",
        "await board.structureCard({",
        "  id: 'c1',",
        "  body: '## Mission\\nFix toast',",
        "  projectId: 'proj-1',",
        "  keepAttachmentIds: ['keep-me'],",
        "});",
        "```",
      ].join("\n"),
    });

    expect(result.error).toBeNull();
    const card = state.cards[0];
    expect(card?.at).toBe("prompts");
    expect(card?.attachments.find((entry) => entry.id === "keep-me")?.include).toBe(true);
    expect(card?.attachments.find((entry) => entry.id === "drop-me")?.include).toBe(false);
  });
});

describe("runHermesProgram with MCP servers", () => {
  const toolset = (
    onCall: (tool: string, args: unknown) => Promise<unknown>,
  ): HermesMcpToolset => ({
    servers: [
      {
        name: "docs",
        url: "https://mcp.example/mcp",
        tools: [
          { name: "search", description: "Search the docs", inputSchema: { type: "object" } },
          { name: "fetch-page", description: "", inputSchema: { type: "object" } },
        ],
        call: onCall,
      },
    ],
    unavailable: [],
  });

  it("calls an MCP tool and records it in the same transcript as board calls", async () => {
    const { api } = makeFakeBoardApi({ cards: [] });
    const seen: unknown[] = [];

    const result = await runHermesProgram({
      api,
      policy,
      mcp: toolset(async (tool, args) => {
        seen.push({ tool, args });
        return { hits: 2 };
      }),
      source: [
        "const found = await mcp.docs.search({ query: 'hermes' });",
        "await board.note({ text: `hits ${found.hits}` });",
      ].join("\n"),
    });

    expect(result.error).toBeNull();
    expect(seen).toEqual([{ tool: "search", args: { query: "hermes" } }]);
    expect(result.calls.map((call) => call.method)).toEqual(["mcp.docs.search", "note"]);
    expect(result.calls[0]?.result).toEqual({ hits: 2 });
    expect(result.note).toBe("hits 2");
  });

  it("binds a tool name that is not an identifier", async () => {
    const { api } = makeFakeBoardApi({ cards: [] });

    const result = await runHermesProgram({
      api,
      policy,
      mcp: toolset(async () => ({ page: "ok" })),
      source: "console.log(JSON.stringify(await mcp.docs['fetch-page']({ url: 'x' })));",
    });

    expect(result.error).toBeNull();
    expect(result.logs.join()).toContain('{"page":"ok"}');
    expect(result.calls[0]?.method).toBe("mcp.docs.fetch-page");
  });

  it("surfaces a failing MCP tool as an error on the call, not a plausible answer", async () => {
    const { api } = makeFakeBoardApi({ cards: [] });

    const result = await runHermesProgram({
      api,
      policy,
      mcp: toolset(async () => {
        throw new Error("index is cold");
      }),
      source: "await mcp.docs.search({ query: 'x' });",
    });

    expect(result.error).toContain("index is cold");
    expect(result.calls[0]?.error).toContain("index is cold");
    expect(result.calls[0]?.result).toBeUndefined();
  });

  it("counts MCP calls against the same per-tick call limit as board calls", async () => {
    const { api } = makeFakeBoardApi({ cards: [] });

    const result = await runHermesProgram({
      api,
      policy,
      maxCalls: 3,
      mcp: toolset(async () => ({ ok: true })),
      source: [
        "for (let i = 0; i < 10; i += 1) {",
        "  await mcp.docs.search({ query: String(i) });",
        "}",
      ].join("\n"),
    });

    expect(result.error).toContain("exceeded 3 board calls");
    expect(result.calls).toHaveLength(3);
  });

  it("leaves mcp undefined when no server is connected", async () => {
    const { api } = makeFakeBoardApi({ cards: [] });

    const result = await runHermesProgram({
      api,
      policy,
      mcp: { servers: [], unavailable: [{ name: "docs", reason: "ECONNREFUSED" }] },
      source: "await mcp.docs.search({ query: 'x' });",
    });

    expect(result.error).toMatch(/'mcp' is not defined/i);
    expect(result.calls).toEqual([]);
  });
});
