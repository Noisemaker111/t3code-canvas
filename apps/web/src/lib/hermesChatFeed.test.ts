import { describe, expect, it } from "vite-plus/test";
import type { CanvasMessage, HermesChatEntry } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { mergeHermesFeed } from "./hermesChatFeed";

const message = (id: string, at: string, patch: Partial<CanvasMessage> = {}): CanvasMessage =>
  ({
    id,
    docId: "doc-1",
    authorKind: "human",
    authorId: null,
    text: "what are you doing",
    image: null,
    hasImage: false,
    target: "hermes",
    targetId: null,
    createdAt: DateTime.makeUnsafe(at),
    deliveredAt: null,
    ...patch,
  }) as CanvasMessage;

const entry = (id: string, at: string, patch: Partial<HermesChatEntry> = {}): HermesChatEntry => ({
  id,
  at,
  kind: "hermes",
  summary: "1 action",
  text: "- updateCard → ok",
  ...patch,
});

describe("mergeHermesFeed", () => {
  it("reads oldest first, whichever source a line came from", () => {
    const rows = mergeHermesFeed({
      messages: [message("m1", "2026-01-01T00:00:10.000Z")],
      entries: [
        entry("chat-1", "2026-01-01T00:00:00.000Z", { kind: "board", summary: "1 decision" }),
        entry("chat-2", "2026-01-01T00:00:20.000Z"),
      ],
    });

    expect(rows.map((row) => row.id)).toEqual(["chat-1", "msg-m1", "chat-2"]);
    expect(rows.map((row) => row.speaker)).toEqual(["board", "you", "hermes"]);
  });

  it("labels who spoke, and leaves a message with nothing to expand", () => {
    const rows = mergeHermesFeed({
      messages: [
        message("m1", "2026-01-01T00:00:00.000Z", { authorKind: "thread", authorId: "thread-abc" }),
      ],
      entries: [],
    });

    expect(rows[0]?.label).toBe("Thread thread-a");
    expect(rows[0]?.text).toBe("");
  });

  it("carries the program and the failure a tick reported", () => {
    const rows = mergeHermesFeed({
      messages: [],
      entries: [
        entry("chat-1", "2026-01-01T00:00:00.000Z", {
          program: "await board.updateCard({ id: 'c1' })",
          error: "executor timed out",
          tier: "openrouter",
        }),
      ],
    });

    expect(rows[0]?.program).toBe("await board.updateCard({ id: 'c1' })");
    expect(rows[0]?.error).toBe("executor timed out");
    expect(rows[0]?.tier).toBe("openrouter");
  });

  it("keeps the newest lines when the feed is longer than the limit", () => {
    const rows = mergeHermesFeed({
      messages: [],
      entries: [
        entry("chat-1", "2026-01-01T00:00:00.000Z"),
        entry("chat-2", "2026-01-01T00:00:01.000Z"),
        entry("chat-3", "2026-01-01T00:00:02.000Z"),
      ],
      limit: 2,
    });

    expect(rows.map((row) => row.id)).toEqual(["chat-2", "chat-3"]);
  });
});
