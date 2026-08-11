/**
 * A checkout whose HEAD no longer resolves.
 *
 * A full disk or a power cut can leave `refs/heads/<branch>` holding a sha
 * whose object never landed. Every later git read dies with `fatal: bad object
 * HEAD`, so the board cannot commit, push or open a pull request for that
 * project again until someone opens a shell on the box. These helpers name that
 * failure and list the commits a repair can re-anchor the branch onto.
 *
 * @module vcs/headRepair
 */

const CORRUPT_HEAD_MARKERS: ReadonlyArray<string> = [
  "bad object head",
  "not a valid object name: 'head'",
  "not a valid object name head",
  "bad object refs/heads/",
  "unable to read head",
  "reference broken",
];

const ZERO_SHA = "0".repeat(40);
const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** Git said HEAD points at something that is not in the object store. */
export function isCorruptHeadGitStderr(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return CORRUPT_HEAD_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Reflog targets newest first, from the raw `logs/refs/heads/<branch>` file.
 *
 * `git reflog` itself is unusable here — it resolves the ref before reading the
 * log, so it fails with the same error the repair exists to undo.
 */
export function parseReflogTargets(reflog: string): ReadonlyArray<string> {
  const targets: string[] = [];
  for (const line of reflog.split("\n")) {
    const sha = line.trim().split(/\s+/)[1]?.toLowerCase();
    if (!sha || sha === ZERO_SHA || !SHA_PATTERN.test(sha)) continue;
    targets.push(sha);
  }
  return Array.from(new Set(targets.reverse()));
}
