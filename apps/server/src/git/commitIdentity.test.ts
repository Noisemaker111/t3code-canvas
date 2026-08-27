import { describe, expect, it } from "@effect/vitest";

import { commitIdentityArgs, resolveCommitIdentity } from "./commitIdentity.ts";

describe("resolveCommitIdentity", () => {
  it("returns the trimmed identity when both halves are set", () => {
    expect(
      resolveCommitIdentity({
        commitAuthorName: "  NoisemakerJon  ",
        commitAuthorEmail: " 139656120+Noisemaker111@users.noreply.github.com ",
      }),
    ).toEqual({
      name: "NoisemakerJon",
      email: "139656120+Noisemaker111@users.noreply.github.com",
    });
  });

  it("refuses a half-set identity rather than merging it with git's implicit ident", () => {
    expect(
      resolveCommitIdentity({ commitAuthorName: "NoisemakerJon", commitAuthorEmail: "" }),
    ).toBeNull();
    expect(
      resolveCommitIdentity({ commitAuthorName: "", commitAuthorEmail: "jon@example.com" }),
    ).toBeNull();
  });

  it("is unset by default", () => {
    expect(resolveCommitIdentity({ commitAuthorName: "", commitAuthorEmail: "" })).toBeNull();
  });
});

describe("commitIdentityArgs", () => {
  it("emits -c overrides that precede the subcommand", () => {
    expect(commitIdentityArgs({ name: "Jon", email: "jon@example.com" })).toEqual([
      "-c",
      "user.name=Jon",
      "-c",
      "user.email=jon@example.com",
    ]);
  });

  it("emits nothing when unset, leaving the box's git config in charge", () => {
    expect(commitIdentityArgs(null)).toEqual([]);
    expect(commitIdentityArgs(undefined)).toEqual([]);
  });
});
