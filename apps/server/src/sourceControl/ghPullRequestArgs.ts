/**
 * Build `gh pr …` argv so forge ops do not depend on the checkout’s current
 * branch. A detached HEAD or bare cwd still works when the reference is a URL
 * or when --repo is known.
 */

/** GitHub pull request URL → owner/name, or null when not a github.com PR URL. */
export function githubRepoFromPrReference(reference: string): string | null {
  const trimmed = reference.trim();
  const match =
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/i.exec(trimmed) ??
    /^https?:\/\/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?$/i.exec(trimmed);
  if (!match?.[1] || !match[2]) return null;
  return `${match[1]}/${match[2]}`;
}

/**
 * Args for `gh pr <verb> <reference> …extra` with optional `--repo` derived
 * from a full PR URL so `gh` does not need `git branch` in cwd.
 */
export function ghPrArgs(
  verb: string,
  reference: string,
  extra: ReadonlyArray<string> = [],
): string[] {
  const repo = githubRepoFromPrReference(reference);
  const head = repo ? ["--repo", repo] : [];
  return ["pr", verb, reference, ...head, ...extra];
}

/** stderr/stdout from `gh pr merge` that mean the PR is already landed. */
export function isAlreadyMergedGhOutput(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("already merged") ||
    lower.includes("pull request is not open") ||
    lower.includes("was already merged") ||
    /state["\s:]+merged/i.test(text)
  );
}

/** JSON state from `gh pr view --json state` (or similar). */
export function isMergedPrState(state: string | null | undefined): boolean {
  return (state ?? "").trim().toUpperCase() === "MERGED";
}
