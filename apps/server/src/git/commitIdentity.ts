import type { GitCommitIdentity } from "../vcs/GitVcsDriver.ts";

/**
 * The commit identity the board should stamp, or `null` to leave the box's
 * git config in charge.
 *
 * Half an identity is refused rather than merged with git's implicit ident:
 * a name with no email still commits as `root@hostname`, which is the exact
 * co-author line this setting exists to remove.
 */
export function resolveCommitIdentity(settings: {
  readonly commitAuthorName: string;
  readonly commitAuthorEmail: string;
}): GitCommitIdentity | null {
  const name = settings.commitAuthorName.trim();
  const email = settings.commitAuthorEmail.trim();
  return name.length > 0 && email.length > 0 ? { name, email } : null;
}

/** `-c` overrides that precede the git subcommand, empty when unset. */
export function commitIdentityArgs(
  identity: GitCommitIdentity | null | undefined,
): ReadonlyArray<string> {
  if (!identity) {
    return [];
  }
  return ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`];
}
