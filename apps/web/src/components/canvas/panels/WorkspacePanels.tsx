import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { ThreadId } from "@t3tools/contracts";
import { lazy, Suspense, useMemo } from "react";

import { DraftId } from "~/composerDraftStore";
import { useProjects } from "~/state/entities";
import { usePrimaryEnvironment } from "~/state/environments";
import { primaryServerKeybindingsAtom } from "~/state/server";
import type { Project } from "~/types";
import { useCanvasStationStore } from "../../../canvasStationStore";
import FileBrowserPanel from "../../files/FileBrowserPanel";
import { editorEntityId, parseWorkspaceFileRef } from "./panelWorkspace";

/**
 * The two workspace panels: a project's file tree, and one file open in the
 * editor the right rail already uses. Both are windows onto a workspace root,
 * so both take the project off their station address
 * (`explorer:<projectId>`, `editor:<projectId>:<path>`) and an empty project id
 * means the board's first project.
 *
 * @module components/canvas/panels/WorkspacePanels
 */

const FilePreviewPanel = lazy(() => import("../../files/FilePreviewPanel"));

/**
 * The canvas has no thread, and the file editor wants one for the asset URLs it
 * builds for image previews. Text files are read against the project's
 * workspace root and never touch it.
 */
const CANVAS_FILES_THREAD_ID = ThreadId.make("__t3_canvas_files__");

const CANVAS_FILES_DRAFT = DraftId.make("canvas-files");

/** The project a workspace panel is a window onto. Empty id means the first one. */
export function useWorkspaceProject(projectId: string): Project | null {
  const projects = useProjects();
  return useMemo(() => {
    if (projects.length === 0) return null;
    if (projectId.length === 0) return projects[0] ?? null;
    return projects.find((project) => project.id === projectId) ?? null;
  }, [projects, projectId]);
}

function NoProject({ what }: { readonly what: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
      Add a project to open {what}.
    </div>
  );
}

export function ExplorerPanel({ entityId }: { readonly entityId: string }) {
  const project = useWorkspaceProject(entityId);
  const requestPanel = useCanvasStationStore((state) => state.requestPanel);

  if (project === null) return <NoProject what="its files" />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FileBrowserPanel
        environmentId={project.environmentId}
        cwd={project.workspaceRoot}
        projectName={project.title}
        onOpenFile={(relativePath) =>
          requestPanel({
            kind: "editor",
            entityId: editorEntityId({ projectId: project.id, relativePath }),
          })
        }
      />
    </div>
  );
}

export function EditorPanel({
  entityId,
  opened,
}: {
  readonly entityId: string;
  readonly opened: boolean;
}) {
  const { projectId, relativePath } = parseWorkspaceFileRef(entityId);
  const project = useWorkspaceProject(projectId);
  const primaryEnvironment = usePrimaryEnvironment();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const requestPanel = useCanvasStationStore((state) => state.requestPanel);
  const threadRef = useMemo(
    () => (project === null ? null : scopeThreadRef(project.environmentId, CANVAS_FILES_THREAD_ID)),
    [project],
  );

  if (project === null || threadRef === null) return <NoProject what="a file" />;

  if (!opened) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-1 p-5">
        <p className="truncate text-sm font-medium text-foreground">
          {relativePath.length === 0 ? "No file open" : relativePath}
        </p>
        <p className="mt-auto text-[11px] text-muted-foreground/70">Zoom in to read the file.</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Suspense fallback={null}>
        <FilePreviewPanel
          environmentId={project.environmentId}
          cwd={project.workspaceRoot}
          projectName={project.title}
          threadRef={threadRef}
          composerDraftTarget={CANVAS_FILES_DRAFT}
          keybindings={keybindings}
          availableEditors={primaryEnvironment?.serverConfig?.availableEditors ?? []}
          relativePath={relativePath.length === 0 ? null : relativePath}
          revealLine={null}
          revealRequestId={0}
          onOpenFile={(next) =>
            requestPanel({
              kind: "editor",
              entityId: editorEntityId({ projectId: project.id, relativePath: next }),
            })
          }
          onPendingChange={() => undefined}
        />
      </Suspense>
    </div>
  );
}
