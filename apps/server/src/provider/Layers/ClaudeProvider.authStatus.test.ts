import { describe, expect, it } from "@effect/vitest";

import { parseClaudeAuthLoggedIn } from "./ClaudeProvider.ts";

describe("parseClaudeAuthLoggedIn", () => {
  it("reads loggedIn false", () => {
    expect(
      parseClaudeAuthLoggedIn(
        JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }),
      ),
    ).toBe(false);
  });

  it("reads loggedIn true", () => {
    expect(parseClaudeAuthLoggedIn(JSON.stringify({ loggedIn: true, email: "a@b.c" }))).toBe(true);
  });

  it("rejects an OAuth account with empty access and refresh tokens", () => {
    expect(
      parseClaudeAuthLoggedIn(
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          oauthAccount: { accessToken: "", refreshToken: "" },
        }),
      ),
    ).toBe(false);
  });

  it("returns undefined for garbage", () => {
    expect(parseClaudeAuthLoggedIn("not json")).toBeUndefined();
  });
});
