/**
 * Workspace-root guards for anything that hands a cwd to an agent.
 *
 * A project rooted at `/` (or at nothing at all) is what a server started
 * without a working directory mints, and every launch that inherits it runs an
 * agent on the whole filesystem. Callers refuse instead.
 *
 * @module workspace/workspaceRootSafety
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Why this root can never host a launch, or null. Pure — no filesystem. */
export function describeUnsafeWorkspaceRoot(
  workspaceRoot: string | null | undefined,
): string | null {
  const raw = (workspaceRoot ?? "").trim();
  if (raw.length === 0) return "the workspace root is empty";
  if (!NodePath.isAbsolute(raw)) return `'${raw}' is a relative path`;
  const resolved = NodePath.resolve(raw);
  if (resolved === NodePath.parse(resolved).root) {
    return `'${resolved}' is the filesystem root`;
  }
  return null;
}

export function isExistingDirectory(path: string): boolean {
  try {
    return NodeFS.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Why this root cannot host a launch right now, or null. Checks existence. */
export function describeUnusableWorkspaceRoot(
  workspaceRoot: string | null | undefined,
  isDirectory: (path: string) => boolean = isExistingDirectory,
): string | null {
  const unsafe = describeUnsafeWorkspaceRoot(workspaceRoot);
  if (unsafe) return unsafe;
  const resolved = NodePath.resolve((workspaceRoot ?? "").trim());
  return isDirectory(resolved) ? null : `'${resolved}' is not an existing directory`;
}
