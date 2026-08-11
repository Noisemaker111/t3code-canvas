import { KanbanBoard } from "../../kanban/KanbanBoard";
import { KanbanPageComposer } from "../../kanban/KanbanPageComposer";

/** The kanban, as a place on the canvas rather than a screen over it. */
export function BoardPanel() {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <KanbanBoard />
      <KanbanPageComposer />
    </div>
  );
}
