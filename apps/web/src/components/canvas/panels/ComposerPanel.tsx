import { KanbanPageComposer } from "../../kanban/KanbanPageComposer";

/**
 * The board capture composer as its own panel under the column row.
 *
 * Docked over a column the composer is a bar floating on its own surface; here
 * the panel is that surface, so it fills the panel instead of drawing a second
 * rounded box a few pixels inside the first.
 */
export function ComposerPanel() {
  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      <KanbanPageComposer surface="panel" />
    </div>
  );
}
