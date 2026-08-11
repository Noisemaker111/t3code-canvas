/**
 * What git actually said, in a form that is safe to show.
 *
 * `GitCommandError` carries output *lengths* and no output, so a failed status
 * reaches the board as "Git status failed." and the only way to learn it was a
 * full disk, a stale `index.lock` or dubious ownership is to open the box by
 * hand. This turns git's own stderr into one bounded line with credentials
 * removed, so the reason can ride along with the failure.
 *
 * Only for reads with no progress channel. A stacked action already publishes
 * git's output as `hook_output` events, and hook output deliberately stays out
 * of the error there.
 *
 * @module vcs/gitFailureDetail
 */

/** Token shapes git echoes back from a remote URL or a credential helper. */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
];

const MAX_LENGTH = 400;

/** Remove credentials from text git is about to have quoted back at a user. */
export function redactGitOutput(text: string): string {
  let redacted = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@");
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "***");
  }
  return redacted;
}

/**
 * One line of git's own words to append to an error `detail`, or `""` when git
 * said nothing worth carrying.
 */
export function describeGitFailure(output: {
  readonly stderr?: string | undefined;
  readonly stdout?: string | undefined;
}): string {
  const source = (output.stderr ?? "").trim() || (output.stdout ?? "").trim();
  if (source.length === 0) return "";
  const line = redactGitOutput(source)
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .join(" | ");
  if (line.length === 0) return "";
  return line.length > MAX_LENGTH ? `${line.slice(0, MAX_LENGTH)}…` : line;
}

/** `detail` with git's reason appended when there is one. */
export function withGitFailureDetail(
  detail: string,
  output: { readonly stderr?: string | undefined; readonly stdout?: string | undefined },
): string {
  const reason = describeGitFailure(output);
  return reason.length > 0 ? `${detail} ${reason}` : detail;
}
