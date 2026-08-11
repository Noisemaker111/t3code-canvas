/**
 * Pure classification of paths under the worktree store root.
 * Used by the health probe and autofix so husks (no git) can be reclaimed.
 */

/** Thread workspaces: `<root>/<project>/thread-<id>`. */
export function isThreadWorktreePath(root: string, absolutePath: string): boolean {
  // Callers pass resolved absolute paths. Normalize separators here so this
  // pure classifier works for both Windows and POSIX without pulling Node's
  // path service into every health-check caller.
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/, "");
  const normalizedPath = absolutePath.replaceAll("\\", "/");
  const prefix = normalizedRoot.length === 0 ? "/" : `${normalizedRoot}/`;
  if (!normalizedPath.startsWith(prefix)) return false;
  const parts = normalizedPath.slice(prefix.length).split("/").filter(Boolean);
  return parts.length === 2 && parts[1]!.startsWith("thread-");
}

/**
 * Top-level store entries that are not a project nest of thread-* dirs and
 * have no git metadata — leftover git-manager / feature probe husks.
 */
export function isHuskStoreEntry(input: {
  readonly name: string;
  readonly hasGit: boolean;
  readonly isDirectory: boolean;
}): boolean {
  if (!input.isDirectory) return false;
  if (input.name.startsWith(".")) return false;
  if (input.hasGit) return false;
  // Project nests (vps-code, jgengine) hold thread-* children; callers pass
  // hasGit false for empty nests without .git — still a husk only when empty
  // of thread-* is decided by the caller. Here: no git ⇒ reclaimable husk
  // candidate when the probe also finds no thread-* children.
  return true;
}

export function isReclaimableHusk(input: {
  readonly name: string;
  readonly hasGit: boolean;
  readonly isDirectory: boolean;
  readonly childNames: ReadonlyArray<string>;
}): boolean {
  if (!isHuskStoreEntry(input)) return false;
  const threads = input.childNames.filter((n) => n.startsWith("thread-"));
  // A project folder with live thread worktrees is not a husk.
  if (threads.length > 0) return false;
  // Empty project-looking dirs or git-manager leftovers without .git.
  return true;
}
