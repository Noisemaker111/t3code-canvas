/**
 * Entity ids for the workspace-scoped panels.
 *
 * A file explorer and a file editor are only meaningful against one project's
 * workspace root, so the station address carries it: `explorer:<projectId>` and
 * `editor:<projectId>:<relative/path.ts>`. An empty project id means "whichever
 * project the board is on" — the palette can offer "Add file explorer" without
 * first making the human pick one.
 *
 * @module components/canvas/panels/panelWorkspace
 */

export interface WorkspaceFileRef {
  /** Empty means the primary project. */
  readonly projectId: string;
  /** Empty means no file chosen yet — the editor shows its own empty state. */
  readonly relativePath: string;
}

export function explorerEntityId(projectId: string): string {
  return projectId;
}

export function editorEntityId(ref: WorkspaceFileRef): string {
  return `${ref.projectId}:${ref.relativePath}`;
}

export function parseWorkspaceFileRef(entityId: string): WorkspaceFileRef {
  const separator = entityId.indexOf(":");
  if (separator === -1) return { projectId: "", relativePath: entityId };
  return {
    projectId: entityId.slice(0, separator),
    relativePath: entityId.slice(separator + 1),
  };
}

/** What the title bar of a file editor says: the file, not the path to it. */
export function workspaceFileLabel(entityId: string): string {
  const { relativePath } = parseWorkspaceFileRef(entityId);
  const trimmed = relativePath.replace(/\/+$/, "");
  if (trimmed.length === 0) return "Editor";
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}
