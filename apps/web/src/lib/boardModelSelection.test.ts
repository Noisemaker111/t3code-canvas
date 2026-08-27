import { describe, expect, it } from "@effect/vitest";

import {
  resolveBoardInstanceId,
  resolveBoardModel,
  resolveRoleInstanceId,
  resolveRoleModel,
} from "./boardModelSelection";

const codex = { instanceId: "codex", enabled: true, selectable: false };
const claude = { instanceId: "claudeAgent", enabled: true, selectable: true };
const grok = { instanceId: "grok", enabled: false, selectable: false };

describe("resolveBoardInstanceId", () => {
  it("keeps the configured instance when it is selectable", () => {
    expect(resolveBoardInstanceId([codex, claude], ["claudeAgent"])).toBe("claudeAgent");
  });

  it("skips a configured instance that is not selectable", () => {
    expect(resolveBoardInstanceId([codex, claude], ["codex"])).toBe("claudeAgent");
  });

  it("falls back through the preference list before the first selectable", () => {
    expect(resolveBoardInstanceId([codex, claude], [null, "codex", "claudeAgent"])).toBe(
      "claudeAgent",
    );
  });

  it("prefers an enabled instance over a disabled one when none are selectable", () => {
    expect(resolveBoardInstanceId([grok, codex], [])).toBe("codex");
  });

  it("returns null when there are no instances", () => {
    expect(resolveBoardInstanceId([], ["codex"])).toBeNull();
  });
});

describe("role pickers keep what is saved", () => {
  it("keeps a configured instance that is not selectable right now", () => {
    expect(resolveRoleInstanceId([codex, claude], "codex")).toBe("codex");
  });

  it("keeps a configured instance while providers have not loaded", () => {
    expect(resolveRoleInstanceId([], "claudeAgent")).toBe("claudeAgent");
  });

  it("falls back only when nothing is configured", () => {
    expect(resolveRoleInstanceId([codex, claude], null)).toBe("claudeAgent");
    expect(resolveRoleInstanceId([codex, claude], null, ["codex"])).toBe("claudeAgent");
  });

  it("keeps a configured model the option list has not caught up with", () => {
    expect(resolveRoleModel("claude-haiku-4-5-20251001", [])).toBe("claude-haiku-4-5-20251001");
    expect(resolveRoleModel("claude-haiku-4-5-20251001", ["opus"])).toBe(
      "claude-haiku-4-5-20251001",
    );
  });

  it("falls back to the first option only when no model is configured", () => {
    expect(resolveRoleModel(null, ["opus", "sonnet"])).toBe("opus");
    expect(resolveRoleModel(null, [])).toBeNull();
  });
});

describe("resolveBoardModel", () => {
  it("keeps a configured model the instance still offers", () => {
    expect(resolveBoardModel("sonnet", ["opus", "sonnet"])).toBe("sonnet");
  });

  it("drops a configured model the instance no longer offers", () => {
    expect(resolveBoardModel("gpt-5.4", ["opus", "sonnet"])).toBe("opus");
  });

  it("keeps the configured model when the instance reports no options", () => {
    expect(resolveBoardModel("gpt-5.4", [])).toBe("gpt-5.4");
  });
});
