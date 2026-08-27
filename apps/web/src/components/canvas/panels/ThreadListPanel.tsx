import type { KanbanCard } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import { useCanvasStationStore } from "../../../canvasStationStore";
import { cardDisplay, useBoardContext } from "../../kanban/KanbanBoard";
import { setThreadDragPayload } from "./threadDrag";
import { THREAD_ROW_COMPONENTS, threadRowCards } from "./threadRows";

/**
 * The thread list — thin rows, one per thread the board still holds.
 *
 * The sidebar shape every thread-first tool has: rows on the left, the work
 * beside them. Click a row and the thread's panel opens *beside this one*,
 * inside whatever frame the list is standing in — which is what makes the
 * Agents frame a chat app rather than a list that throws its pages across the
 * canvas. Drag a row instead and the thread opens where you drop it.
 */

const SECTION_LABELS: Record<string, string> = { active: "Active", pr: "PR", done: "Done" };

export function ThreadListPanel({ entityId }: { readonly entityId: string }) {
  const board = useBoardContext();
  const requestPanel = useCanvasStationStore((state) => state.requestPanel);

  const cards = threadRowCards(THREAD_ROW_COMPONENTS.flatMap((id) => board?.grouped.get(id) ?? []));
  const open = (threadId: string) =>
    requestPanel({ kind: "thread", entityId: threadId }, { near: { kind: "threads", entityId } });
  // Section labels only once the list spans more than the Active column.
  const sectioned = cards.some((card) => card.at !== "active");

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto py-1"
      data-testid="thread-list-panel"
    >
      {cards.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          No threads yet. Launch one from the board.
        </p>
      ) : (
        cards.map((card, index) => (
          <div key={card.id} className="flex shrink-0 flex-col">
            {sectioned && card.at !== cards[index - 1]?.at ? (
              <p className="px-3 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {SECTION_LABELS[card.at] ?? card.at}
              </p>
            ) : null}
            <ThreadRow
              card={card}
              working={board?.hermesWorkingIds.has(card.id) === true}
              onOpen={open}
            />
          </div>
        ))
      )}
    </div>
  );
}

function ThreadRow({
  card,
  working,
  onOpen,
}: {
  readonly card: KanbanCard;
  readonly working: boolean;
  readonly onOpen: (threadId: string) => void;
}) {
  const threadId = card.threadId ?? "";
  const title = cardDisplay(card);

  return (
    <button
      type="button"
      className="flex w-full shrink-0 items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-accent"
      data-testid={`thread-list-row-${threadId}`}
      draggable={threadId.length > 0}
      onDragStart={(event) => setThreadDragPayload(event.dataTransfer, threadId, title)}
      onClick={() => onOpen(threadId)}
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          working
            ? "animate-pulse bg-amber-500"
            : card.at === "active"
              ? "bg-emerald-500"
              : card.at === "pr"
                ? "bg-violet-500"
                : "bg-muted-foreground/50",
        )}
      />
      <span className="truncate">{title}</span>
    </button>
  );
}
