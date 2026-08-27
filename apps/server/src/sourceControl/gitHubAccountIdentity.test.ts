import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { parseGitHubAccountIdentity } from "./gitHubAccountIdentity.ts";

const USER_JSON = JSON.stringify({
  login: "Noisemaker111",
  id: 139656120,
  name: "NoisemakerJon",
  avatar_url: "https://avatars.githubusercontent.com/u/139656120?v=4",
  email: "unverified@example.com",
});

describe("parseGitHubAccountIdentity", () => {
  it("builds the noreply address GitHub resolves back to the account", () => {
    expect(parseGitHubAccountIdentity(USER_JSON)).toEqual({
      provider: "github",
      account: "Noisemaker111",
      name: "NoisemakerJon",
      email: "139656120+Noisemaker111@users.noreply.github.com",
      avatarUrl: Option.some("https://avatars.githubusercontent.com/u/139656120?v=4"),
    });
  });

  it("falls back to the login when the account has no display name or avatar", () => {
    const identity = parseGitHubAccountIdentity(
      JSON.stringify({ login: "octocat", id: 583231, name: null, avatar_url: "  " }),
    );
    expect(identity?.name).toBe("octocat");
    expect(identity?.avatarUrl).toEqual(Option.none());
  });

  it("returns null for output that is not a user payload", () => {
    expect(parseGitHubAccountIdentity("")).toBeNull();
    expect(parseGitHubAccountIdentity("gh: not authenticated")).toBeNull();
    expect(parseGitHubAccountIdentity(JSON.stringify({ login: "", id: 1 }))).toBeNull();
  });
});
