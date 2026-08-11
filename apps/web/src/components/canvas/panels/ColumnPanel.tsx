import { useNavigate } from "@tanstack/react-router";

import { BoardColumn, useBoardContext } from "../../kanban/KanbanBoard";
import { KanbanPageComposer } from "../../kanban/KanbanPageComposer";
import { useCompactLayout } from "./compactLayout";
import { stationKey } from "./panelStations";

/**
 * One kanban at as its own place on the canvas: movable, resizable, and a
 * drop target for cards dragged out of any other at panel. On a phone the
 * focused at is the whole board page, so it wears the at tabs and the
 * capture composer the monolithic board page used to own.
 *
 * The panel's entity id *is* the at id. Which columns exist is board
 * settings, so there is nothing here to validate against — an id settings no
 * longer names still has cards in it and still gets a panel.
 */

/** The at a panel stands for: its address, verbatim. */
export function columnPanelId(entityId: string): string {
  return entityId;
}

export function ColumnPanel({ entityId }: { readonly entityId: string }) {
  const compact = useCompactLayout();
  const navigate = useNavigate();
  const board = useBoardContext();
  const at = columnPanelId(entityId);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {compact ? (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {(board?.columns ?? []).map((entry) => (
            <button
              key={entry.id}
              type="button"
              data-active={entry.id === at ? "true" : undefined}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] text-muted-foreground data-[active=true]:bg-accent data-[active=true]:text-foreground"
              onClick={() => {
                void navigate({
                  to: "/kanban",
                  search: { station: stationKey({ kind: "column", entityId: entry.id }) },
                  replace: true,
                });
              }}
            >
              {entry.title}
              <span className="tabular-nums opacity-70">
                {(board?.grouped.get(entry.id) ?? []).length}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <BoardColumn column={at} compact={compact} />
      {compact ? <KanbanPageComposer /> : null}
    </div>
  );
}
