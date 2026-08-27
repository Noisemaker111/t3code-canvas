import type { SourceControlAccountIdentity } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const GitHubUserSchema = Schema.Struct({
  login: Schema.String,
  id: Schema.Number,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeGitHubUserJson = Schema.decodeUnknownOption(Schema.fromJsonString(GitHubUserSchema));

/** `gh api user`, the read that answers who the box commits as. */
export const GITHUB_ACCOUNT_IDENTITY_ARGS: ReadonlyArray<string> = ["api", "user"];

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
}

/**
 * The identity of the signed-in `gh` account.
 *
 * `id+login@users.noreply.github.com` is the address GitHub resolves back to
 * that account, so commits stamped with it carry the account's display name
 * and avatar. The account's public email is deliberately ignored: it is not
 * always a verified commit email, and an unverified one attributes to nobody.
 */
export function parseGitHubAccountIdentity(text: string): SourceControlAccountIdentity | null {
  return Option.match(decodeGitHubUserJson(text), {
    onNone: () => null,
    onSome: (user) => {
      const login = nonEmpty(user.login);
      if (login === null || !Number.isSafeInteger(user.id)) return null;
      const avatarUrl = nonEmpty(user.avatar_url);

      return {
        provider: "github" as const,
        account: login,
        name: nonEmpty(user.name) ?? login,
        email: `${user.id}+${login}@users.noreply.github.com`,
        avatarUrl: avatarUrl === null ? Option.none() : Option.some(avatarUrl),
      };
    },
  });
}
