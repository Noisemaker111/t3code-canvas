import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  appendHermesChat,
  bindHermesChat,
  hermesChatEntries,
  restoreHermesChat,
  unbindHermesChat,
} from "./chatStore.ts";

const dirs: string[] = [];

function bind(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hermes-chat-"));
  dirs.push(dir);
  bindHermesChat(dir);
  return dir;
}

const line = (summary: string) => ({
  at: "2026-01-01T00:00:00.000Z",
  kind: "hermes" as const,
  summary,
  text: "- updateCard → ok",
});

afterEach(() => {
  unbindHermesChat();
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

describe("chatStore", () => {
  it("hands out one id per line and reads them back oldest first", () => {
    bind();
    const first = appendHermesChat([line("one"), line("two")]);
    expect(first.map((entry) => entry.id)).toEqual(["chat-1", "chat-2"]);
    expect(hermesChatEntries().map((entry) => entry.summary)).toEqual(["one", "two"]);
  });

  it("survives a restart, which is when the panel most needs it", () => {
    const dir = bind();
    appendHermesChat([line("before the restart")]);
    unbindHermesChat();
    expect(hermesChatEntries()).toEqual([]);

    bindHermesChat(dir);
    restoreHermesChat();
    expect(hermesChatEntries().map((entry) => entry.summary)).toEqual(["before the restart"]);
    expect(appendHermesChat([line("after")])[0]?.id).toBe("chat-2");
  });

  it("keeps writing when there is nowhere to write to", () => {
    unbindHermesChat();
    expect(appendHermesChat([line("in memory only")])[0]?.id).toBe("chat-1");
    expect(hermesChatEntries()).toHaveLength(1);
  });
});
