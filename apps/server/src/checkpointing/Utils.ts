import * as Encoding from "effect/Encoding";
import { CheckpointRef, ProjectId, type ThreadId } from "@t3tools/contracts";

import { describeUnsafeWorkspaceRoot } from "../workspace/workspaceRootSafety.ts";

export const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

/**
 * The directory a thread's agent runs in, or the reason there isn't one.
 *
 * Never falls back to the server's own cwd: that is how a thread whose project
 * was deleted — or was rooted at `/` — ended up running an agent wherever the
 * server process happened to be started.
 */
export function describeThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): { readonly cwd: string } | { readonly reason: string } {
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  const candidate =
    worktreeCwd ??
    input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot;
  if (candidate === undefined) {
    return {
      reason: `thread has no worktree and project '${input.thread.projectId}' has no workspace root`,
    };
  }
  const unsafe = describeUnsafeWorkspaceRoot(candidate);
  return unsafe ? { reason: unsafe } : { cwd: candidate };
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const described = describeThreadWorkspaceCwd(input);
  return "cwd" in described ? described.cwd : undefined;
}
