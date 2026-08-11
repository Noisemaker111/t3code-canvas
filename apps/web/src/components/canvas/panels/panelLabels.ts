import { columnTitleFromId } from "./boardColumns";
import { browserPanelTitle } from "./panelBrowser";
import { panelManifest, type PanelKind } from "./panelRegistry";
import { terminalPanelTitle } from "./panelTerminal";
import { workspaceFileLabel } from "./panelWorkspace";
import { parseRepoBinding, repoBindingLabel } from "./PrReviewPanel.logic";

/**
 * What a panel is called in its title bar.
 *
 * Its own module rather than `PanelContent`'s, because a title is wanted by
 * things that must not pull a panel body in with it: `FrameView` draws a tab
 * strip out of these, and importing the render half would put a transcript, a
 * terminal and a diff worker behind a gallery specimen of a tab.
 *
 * @module components/canvas/panels/panelLabels
 */

const PANEL_LABELS: Partial<Record<PanelKind, (entityId: string) => string>> = {
  browser: (entityId) => browserPanelTitle(entityId),
  column: (entityId) => columnTitleFromId(entityId),
  thread: (entityId) => `Thread ${entityId.slice(0, 8)}`,
  editor: (entityId) => workspaceFileLabel(entityId),
  terminal: (entityId) => terminalPanelTitle(entityId),
  prs: (entityId) => {
    const repos = parseRepoBinding(entityId);
    return repos.length === 0 ? "Pull requests" : repoBindingLabel(repos);
  },
  issues: (entityId) => {
    const repos = parseRepoBinding(entityId);
    return repos.length === 0 ? "Issues" : `Issues · ${repoBindingLabel(repos)}`;
  },
};

/**
 * What a panel is called: the name typed on it, else what its kind makes of its
 * address. A column's name lives on the panel, so `title` is the whole answer
 * for one that has been renamed and the id is what an unnamed one reads as.
 */
export function panelLabel(kind: PanelKind, entityId: string, title = ""): string {
  const typed = title.trim();
  if (typed.length > 0) return typed;
  const refine = PANEL_LABELS[kind];
  return refine === undefined ? panelManifest(kind).label : refine(entityId);
}
