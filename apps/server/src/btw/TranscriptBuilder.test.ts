import { assert, describe, it } from "@effect/vitest";

import type { ConversationLogEntry } from "../persistence/Services/ConversationLog.ts";
import { ThreadId } from "@t3tools/contracts";
import {
  applyTranscriptBudget,
  buildBtwSystemPrompt,
  composeBtwPrompt,
  formatTranscriptEntry,
} from "./TranscriptBuilder.ts";

const threadId = ThreadId.make("thread-transcript");

const entry = (over: Partial<ConversationLogEntry>): ConversationLogEntry => ({
  createdAt: "2026-02-28T19:00:00.000Z",
  projectId: "project-1",
  threadId,
  turnId: null,
  entryType: "prompt",
  role: "user",
  toolKind: null,
  text: "hello",
  tokens: null,
  durationMs: null,
  ...over,
});

describe("TranscriptBuilder", () => {
  it("tags an entry with type, duration, and tokens", () => {
    const formatted = formatTranscriptEntry(
      entry({ entryType: "response", role: "assistant", text: "hi", tokens: 42, durationMs: 1500 }),
    );
    assert.equal(formatted, "[response · 1.5s · 42 tok]\nhi");
  });

  it("drops the oldest tool_call entries first when over budget", () => {
    const entries = [
      entry({ entryType: "tool_call", toolKind: "bash", text: "old tool", tokens: 100 }),
      entry({ entryType: "tool_call", toolKind: "bash", text: "newer tool", tokens: 100 }),
      entry({ entryType: "response", role: "assistant", text: "answer", tokens: 100 }),
    ];
    // 300 tokens total against a 250 budget: dropping the one oldest tool_call
    // gets under it, so the loop stops there. (This asserted a 150 budget,
    // which cannot be met by dropping one 100-token entry out of three — the
    // budget loop correctly dropped two, and the assertion below never held.)
    const result = applyTranscriptBudget(entries, 250);
    assert.equal(result.truncated, true);
    assert.equal(result.droppedToolCalls, 1);
    // The oldest tool_call is dropped; the response is always kept.
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0]?.text, "newer tool");
    assert.equal(result.entries[1]?.text, "answer");
  });

  it("notes truncation in the system prompt", () => {
    const entries = [
      entry({ entryType: "tool_call", toolKind: "bash", text: "old", tokens: 1000 }),
      entry({ entryType: "response", role: "assistant", text: "kept", tokens: 10 }),
    ];
    const prompt = buildBtwSystemPrompt(entries, 100);
    assert.ok(prompt.includes("truncated"));
    assert.ok(prompt.includes("TRANSCRIPT:"));
  });

  it("keeps btw history intact when composing the prompt", () => {
    const prompt = composeBtwPrompt({
      systemPrompt: "SYS",
      history: [
        { btwSessionId: "btw:x", threadId, role: "user", content: "q1", createdAt: "t0" },
        { btwSessionId: "btw:x", threadId, role: "assistant", content: "a1", createdAt: "t1" },
      ],
      newMessage: "q2",
    });
    assert.ok(prompt.includes("SYS"));
    assert.ok(prompt.includes("User: q1"));
    assert.ok(prompt.includes("Assistant: a1"));
    assert.ok(prompt.includes("q2"));
  });
});
