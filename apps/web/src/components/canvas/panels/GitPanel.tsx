import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { GitBranchIcon, RefreshCwIcon } from "lucide-react";
import { useMemo } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import { cn } from "~/lib/utils";

import GitActionsControl from "../../GitActionsControl";
import { useCanvasStationStore } from "../../../canvasStationStore";
import { editorEntityId } from "./panelWorkspace";
import { useWorkspaceProject } from "./WorkspacePanels";

/**
 * Git for a project's working tree, as a panel: the branch it is on, what has
 * changed, and the actions the chat header already carries.
 *
 * The IDE frame's fourth pane. It is a window onto a *workspace*, not a thread
 * — the canvas has no thread — so it takes the project off its station address
 * (`git:<projectId>`) like the explorer and the editor do, and an empty project
 * id means the board's first project.
 *
 * `GitActionsControl` is the whole of commit / push / open PR. Reimplementing
 * those here would be a second git front end with its own idea of when a
 * default-branch commit needs confirming.
 */

/**
 * The actions control wants a thread to scope its toasts and branch metadata
 * to. The canvas has none, so every git panel shares this one id — the same
 * shape the file panels use for their asset URLs.
 */
const CANVAS_GIT_THREAD_ID = ThreadId.make("__t3_canvas_git__");

export function GitPanel({ entityId }: { readonly entityId: string }) {
  const project = useWorkspaceProject(entityId);
  const requestPanel = useCanvasStationStore((state) => state.requestPanel);
  const environmentId = project?.environmentId ?? null;
  const cwd = project?.workspaceRoot ?? null;

  const status = useEnvironmentQuery(
    environmentId !== null && cwd !== null
      ? vcsEnvironment.status({ environmentId, input: { cwd } })
      : null,
  );
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const threadRef = useMemo(
    () => (environmentId === null ? null : scopeThreadRef(environmentId, CANVAS_GIT_THREAD_ID)),
    [environmentId],
  );

  if (project === null || cwd === null || environmentId === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Add a project to work its git tree.
      </div>
    );
  }

  const value = status.data ?? null;
  const files = value?.workingTree.files ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="git-panel">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-xs text-foreground">
          {value?.refName ?? "no branch"}
        </span>
        <div className="ms-auto flex items-center gap-1">
          <button
            type="button"
            aria-label="Refresh git status"
            className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => {
              void refreshStatus({ environmentId, input: { cwd } });
              status.refresh();
            }}
          >
            <RefreshCwIcon className="size-3.5" />
          </button>
          {threadRef === null ? null : (
            <GitActionsControl gitCwd={cwd} activeThreadRef={threadRef} />
          )}
        </div>
      </div>

      {value !== null && !value.isRepo ? (
        <p className="p-3 text-xs text-muted-foreground">{cwd} is not a git repository.</p>
      ) : files.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">
          {value === null ? "Reading the working tree…" : "Nothing changed."}
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto py-1">
          {files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                className="flex w-full items-baseline gap-2 px-3 py-1 text-left text-xs hover:bg-accent"
                data-testid={`git-panel-file-${file.path}`}
                onClick={() =>
                  requestPanel({
                    kind: "editor",
                    entityId: editorEntityId({ projectId: project.id, relativePath: file.path }),
                  })
                }
              >
                <span className="truncate text-foreground">{file.path}</span>
                <span className="ms-auto shrink-0 font-mono text-[11px] tabular-nums">
                  <span className={cn(file.insertions > 0 && "text-emerald-500")}>
                    +{file.insertions}
                  </span>{" "}
                  <span className={cn(file.deletions > 0 && "text-red-500")}>
                    -{file.deletions}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {value === null || files.length === 0 ? null : (
        <p className="shrink-0 border-t border-border px-3 py-1.5 text-[11px] tabular-nums text-muted-foreground">
          {files.length} changed · +{value.workingTree.insertions} −{value.workingTree.deletions}
          {value.aheadCount > 0 ? ` · ${value.aheadCount} ahead` : ""}
          {value.behindCount > 0 ? ` · ${value.behindCount} behind` : ""}
        </p>
      )}
    </div>
  );
}
