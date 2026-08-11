/**
 * Where per-thread workspaces live on disk.
 *
 * Worktree identity is **thread-scoped**, not branch-scoped: two threads
 * started from the same base branch must land in two different directories.
 * The branch name stays metadata — it is still created and reported — it just
 * no longer decides the directory.
 *
 * Everything here returns absolute paths. A relative (or empty) workspace root
 * is how `rift create` ends up resolving against `/` and failing with
 * `mkdir: cannot create directory '/<branch>': Permission denied`.
 *
 * @module vcs/worktreeLayout
 */
import * as NodePath from "node:path";

/** Env override for the workspace root. Read literally — do not rename. */
export const WORKTREE_ROOT_ENV_KEY = "T3CODE_WORKTREE_ROOT";

/** Directory name used for the default (sibling-of-project) workspace root. */
export const WORKTREE_ROOT_DIR_NAME = ".worktrees";

/** Prefix for a thread-scoped workspace directory. */
export const THREAD_WORKTREE_PREFIX = "thread-";

/** The `Path.Path` surface this module needs, so it is trivially testable. */
export interface WorktreePathApi {
  readonly join: (...segments: ReadonlyArray<string>) => string;
  readonly resolve: (...segments: ReadonlyArray<string>) => string;
  readonly dirname: (path: string) => string;
  readonly isAbsolute: (path: string) => boolean;
}

export type WorktreeEnv = Readonly<Record<string, string | undefined>>;

/**
 * `node:path` as a `WorktreePathApi`, for callers that must not add
 * `Path.Path` to their requirement channel.
 */
export const nodeWorktreePath: WorktreePathApi = {
  join: (...segments) => NodePath.join(...segments),
  resolve: (...segments) => NodePath.resolve(...segments),
  dirname: (value) => NodePath.dirname(value),
  isAbsolute: (value) => NodePath.isAbsolute(value),
};

/**
 * Reduce an arbitrary identifier to something safe as a single path segment.
 */
export function sanitizeWorktreeSegment(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|-+$/g, "");
  return normalized.length > 0 ? normalized.slice(0, 100) : "workspace";
}

/**
 * Absolute directory that holds every workspace created from `projectCwd`.
 *
 * `T3CODE_WORKTREE_ROOT` wins when set. Otherwise the root is the
 * `.worktrees` sibling of the project checkout — on the VPS projects live at
 * `/root/projects/<repo>`, so the default is `/root/projects/.worktrees`,
 * while local dev and CI stay inside their own temp/workspace trees.
 */
export function resolveWorktreeRoot(input: {
  readonly path: WorktreePathApi;
  readonly projectCwd: string;
  readonly env?: WorktreeEnv;
}): string {
  const { path } = input;
  const env = input.env ?? process.env;
  const projectRoot = path.resolve(input.projectCwd);
  const configured = (env[WORKTREE_ROOT_ENV_KEY] ?? "").trim();
  if (configured.length > 0) {
    return path.isAbsolute(configured)
      ? path.resolve(configured)
      : path.resolve(projectRoot, configured);
  }
  return path.join(path.dirname(projectRoot), WORKTREE_ROOT_DIR_NAME);
}

/**
 * Absolute directory holding one project's thread workspaces:
 * `<root>/<projectSlug>`. Every project used to share one flat `.worktrees`
 * keyed only by thread id, so two projects' workspaces sat side by side with
 * nothing in the path saying which checkout they came from.
 */
export function projectWorktreeRoot(input: {
  readonly path: WorktreePathApi;
  readonly projectCwd: string;
  readonly env?: WorktreeEnv;
}): string {
  const projectRoot = input.path.resolve(input.projectCwd);
  const slug = sanitizeWorktreeSegment(
    projectRoot.split(/[/\\]/).filter(Boolean).pop() ?? "project",
  );
  return input.path.join(resolveWorktreeRoot(input), slug);
}

/**
 * Absolute workspace path for one thread. Two threads on the same base branch
 * (and even on the same branch name) get two different directories because the
 * thread id — not the branch — is the key.
 */
export function buildThreadWorktreePath(input: {
  readonly path: WorktreePathApi;
  readonly projectCwd: string;
  readonly threadId: string;
  readonly env?: WorktreeEnv;
}): string {
  return input.path.join(
    projectWorktreeRoot(input),
    `${THREAD_WORKTREE_PREFIX}${sanitizeWorktreeSegment(input.threadId)}`,
  );
}

/**
 * True when `candidate` is a thread-scoped workspace under `projectCwd`'s own
 * workspace directory. Teardown only ever removes paths this returns true for,
 * so a project checkout, another project's workspace, or a hand-made worktree
 * can never be reaped by accident.
 */
export function isThreadWorktreePath(input: {
  readonly path: WorktreePathApi;
  readonly projectCwd: string;
  readonly candidate: string;
  readonly env?: WorktreeEnv;
}): boolean {
  const root = projectWorktreeRoot(input);
  const candidate = input.path.resolve(input.candidate);
  if (candidate === root) return false;
  return input.path.dirname(candidate) === root;
}
