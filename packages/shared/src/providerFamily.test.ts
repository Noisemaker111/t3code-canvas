import { describe, expect, it } from "@effect/vitest";

import {
  FAMILY_ORG_PREFIX,
  isSubscriptionFamily,
  usageProviderIdForInstance,
} from "./providerFamily.ts";

describe("usageProviderIdForInstance", () => {
  it("maps claude instance slugs to the claude family", () => {
    expect(usageProviderIdForInstance("claudeAgent")).toBe("claude");
    expect(usageProviderIdForInstance("claude_work")).toBe("claude");
    expect(usageProviderIdForInstance("claude-personal")).toBe("claude");
  });

  it("prefix-matches the known families", () => {
    expect(usageProviderIdForInstance("codex")).toBe("codex");
    expect(usageProviderIdForInstance("codex_team")).toBe("codex");
    expect(usageProviderIdForInstance("cursor-2")).toBe("cursor");
  });

  it("passes an unknown slug through so new drivers stay routable", () => {
    expect(usageProviderIdForInstance("SomeNewProvider")).toBe("somenewprovider");
  });
});

describe("subscription families", () => {
  it("separates quota-billed families from USD-billed ones", () => {
    expect(isSubscriptionFamily("claude")).toBe(true);
    expect(isSubscriptionFamily("codex")).toBe(true);
    expect(isSubscriptionFamily("openrouter")).toBe(false);
  });

  it("has an org prefix entry for every family that needs one", () => {
    expect(FAMILY_ORG_PREFIX["claude"]).toBe("anthropic");
    expect(FAMILY_ORG_PREFIX["codex"]).toBe("openai");
    expect(FAMILY_ORG_PREFIX["grok"]).toBe("x-ai");
  });
});
