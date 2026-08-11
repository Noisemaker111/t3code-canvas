import { describe, expect, it } from "@effect/vitest";

import { threadRowCards } from "./threadRows";

describe("threadRowCards", () => {
  const card = (over: {
    threadId?: string | null;
    at?: string;
    position?: number;
    archivedAt?: unknown;
  }) => ({
    threadId: "t1",
    at: "active",
    position: 0,
    archivedAt: null,
    ...over,
  });

  it("keeps live threaded cards, Active first, then PR, then Done", () => {
    const rows = threadRowCards([
      card({ threadId: "t5", at: "done", position: 0 }),
      card({ threadId: "t2", position: 2 }),
      card({ threadId: "t4", at: "pr", position: 1 }),
      card({ threadId: "t1", position: 1 }),
      card({ threadId: null }),
      card({ threadId: "t6", at: "prompts" }),
      card({ threadId: "t7", archivedAt: "2026-08-01" }),
      card({ threadId: "" }),
    ]);
    expect(rows.map((row) => row.threadId)).toEqual(["t1", "t2", "t4", "t5"]);
  });
});
