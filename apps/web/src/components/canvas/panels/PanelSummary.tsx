import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type KanbanCard } from "@t3tools/contracts";
import { useMemo, useRef, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { usePrimaryEnvironment } from "~/state/environments";
import { useOpenPrs } from "~/state/kanban";
import { columnPanelId } from "./ColumnPanel";
import {
  cardDisplay,
  cardIsPlaceholder,
  useBoardColumnView,
  useBoardContext,
} from "../../kanban/KanbanBoard";
import { CardView } from "../../kanban/CardTileView";
import {
  describeCardQueue,
  toBoardHermesCardSlice,
  type CardQueueState,
} from "../../kanban/KanbanBoard.logic";
import { cardIdForPr, parseRepoBinding, prCardIndex } from "./PrReviewPanel.logic";
import { PanelPlaceholder } from "./PanelChrome";
import { panelManifest, type PanelKind } from "./panelRegistry";
import { panelTier, type PanelTier, type ScreenSize } from "./panelTiers";

/**
 * The summary tier, in pixels.
 *
 * Two things at once: what keeps twenty panels off the main thread on a
 * zoomed-out canvas, and what makes that canvas worth looking at — the columns
 * still say how many cards they hold and in what state, the threads still say
 * whether they are running. Which is why every view in here reads something the
 * board already has in memory and nothing else: no transcripts, no diff workers,
 * no request a live panel would not already have made.
 *
 * The views are split presentational-half / reading-half so the dev gallery can
 * render the same component the canvas renders, from props.
 *
 * @module components/canvas/panels/PanelSummary
 */

/**
 * Which tier a panel drawn at this on-screen size renders at, with the last
 * frame's answer remembered so the boundaries do not strobe under a pinch.
 *
 * A ref rather than state: the callers re-render on every camera frame anyway,
 * and a `setState` per frame of a zoom gesture is the cost this is here to save.
 */
export function usePanelTier(kind: PanelKind, screen: ScreenSize): PanelTier {
  const previous = useRef<PanelTier | null>(null);
  const tier = panelTier({ kind, screen, previous: previous.current });
  previous.current = tier.size;
  return tier.render;
}

export function PanelSummaryView({
  kind,
  entityId,
  label,
}: {
  readonly kind: PanelKind;
  readonly entityId: string;
  /** The panel's own title — a refined one for the instanced kinds. */
  readonly label: string;
}) {
  const summary = panelManifest(kind).summary;
  switch (summary.view) {
    case "none":
      return <PanelPlaceholder />;
    case "static":
      return <PanelSummaryCard title={label} line={summary.line} />;
    case "column":
      return <ColumnSummary entityId={entityId} />;
    case "thread":
      return <ThreadSummary threadId={entityId} label={label} />;
    case "prs":
      return <PrsSummary entityId={entityId} label={label} />;
  }
}

/** Every summary is this: a title, a line under it, and the kind's own detail. */
export function PanelSummaryCard({
  title,
  line,
  children,
}: {
  readonly title: string;
  readonly line: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-4" data-testid="canvas-panel-summary">
      <p className="truncate text-base font-medium text-foreground">{title}</p>
      <div className="text-xs text-muted-foreground">{line}</div>
      {children}
    </div>
  );
}

/** Past this many rows a column stops being readable and starts being a list. */
export const MAX_SUMMARY_CARDS = 12;

/** A card as the summary draws it: its headline and its own status, nothing else. */
export interface ColumnSummaryCard {
  readonly id: string;
  readonly headline: string;
  /** A prompt with nothing written yet — the headline renders as a hint. */
  readonly placeholder?: boolean | undefined;
  readonly queueState?: CardQueueState | null | undefined;
}

export function ColumnSummaryView({
  title,
  count,
  cards,
}: {
  readonly title: string;
  readonly count: number;
  /** In column order, capped at {@link MAX_SUMMARY_CARDS}. */
  readonly cards: ReadonlyArray<ColumnSummaryCard>;
}) {
  return (
    <PanelSummaryCard title={title} line={count === 1 ? "1 card" : `${count} cards`}>
      <div
        className="flex min-h-0 flex-col gap-1 overflow-hidden"
        data-testid="canvas-summary-cards"
      >
        {cards.map((card) => (
          <CardView
            key={card.id}
            renderer="compact"
            headline={card.headline}
            placeholder={card.placeholder}
            queueState={card.queueState}
          />
        ))}
        {count > cards.length ? (
          <p className="px-1 text-[10px] tabular-nums text-muted-foreground/70">
            +{count - cards.length} more
          </p>
        ) : null}
      </div>
    </PanelSummaryCard>
  );
}

function ColumnSummary({ entityId }: { readonly entityId: string }) {
  const column = columnPanelId(entityId);
  const board = useBoardContext();
  const cards: ReadonlyArray<KanbanCard> = board?.grouped.get(column) ?? [];

  // The board's own reading of each card, not a second one: a row is the line
  // the card would be wearing if you zoomed in on it. Nothing here reads
  // anything the board does not already hold in memory.
  const rows = useMemo(() => {
    if (board === null) return [];
    return cards.slice(0, MAX_SUMMARY_CARDS).map(
      (card): ColumnSummaryCard => ({
        id: card.id,
        headline: cardIsPlaceholder(card) ? "Write a prompt..." : cardDisplay(card),
        placeholder: cardIsPlaceholder(card),
        queueState: describeCardQueue({
          card: toBoardHermesCardSlice(card),
          hasLiveSkillJob: board.hermesWorkingIds.has(card.id),
          context: board.queueContext,
        }),
      }),
    );
  }, [board, cards]);

  const title = useBoardColumnView(column).title;
  if (board === null) return <PanelSummaryCard title={title} line="Board not loaded." />;
  return <ColumnSummaryView title={title} count={cards.length} cards={rows} />;
}

/** A pull request the board already has a card for is somebody's; the rest are not. */
export type PrSummaryDot = "owned" | "orphan";

/** Past this many dots they stop being countable and start being texture. */
export const MAX_SUMMARY_DOTS = 24;

const PR_DOT_CLASS: Record<PrSummaryDot, string> = {
  owned: "bg-emerald-500",
  orphan: "bg-muted-foreground/40",
};

export function PrsSummaryView({
  title,
  count,
  dots,
}: {
  readonly title: string;
  readonly count: number;
  /** One per open pull request, capped at {@link MAX_SUMMARY_DOTS}. */
  readonly dots: ReadonlyArray<PrSummaryDot>;
}) {
  return (
    <PanelSummaryCard
      title={title}
      line={count === 1 ? "1 open pull request" : `${count} open pull requests`}
    >
      <div className="flex flex-wrap content-start gap-1.5" data-testid="canvas-summary-dots">
        {dots.map((dot, index) => (
          <span key={`${dot}-${index}`} className={cn("size-2 rounded-full", PR_DOT_CLASS[dot])} />
        ))}
      </div>
    </PanelSummaryCard>
  );
}

/**
 * Which pull requests the board already has a card for. The board's own cards,
 * nothing fetched: this rung reads what is in memory, and the open-PR list is
 * the same query the live panel makes, cached by the atom family behind it.
 */
export function prSummaryDots(
  prs: ReadonlyArray<{ readonly url: string; readonly number: number }>,
  cards: ReadonlyArray<Pick<KanbanCard, "id" | "prUrl" | "prNumber">>,
): ReadonlyArray<PrSummaryDot> {
  const index = prCardIndex(cards);
  return prs
    .slice(0, MAX_SUMMARY_DOTS)
    .map((pr) => (cardIdForPr(index, pr) === null ? "orphan" : "owned"));
}

function PrsSummary({ entityId, label }: { readonly entityId: string; readonly label: string }) {
  const repos = useMemo(() => parseRepoBinding(entityId), [entityId]);
  const { prs, error } = useOpenPrs(repos);
  const board = useBoardContext();
  const dots = useMemo(
    () => prSummaryDots(prs, board === null ? [] : [...board.grouped.values()].flat()),
    [board, prs],
  );

  if (error !== null && error !== undefined) {
    return <PanelSummaryCard title={label} line="The forge would not answer." />;
  }
  return <PrsSummaryView title={label} count={prs.length} dots={dots} />;
}

export function ThreadSummaryView({
  title,
  status,
  running,
  branch,
}: {
  readonly title: string;
  readonly status: string;
  readonly running: boolean;
  readonly branch: string | null;
}) {
  return (
    <PanelSummaryCard
      title={title}
      line={
        <span className="inline-flex items-center gap-1.5">
          <span
            className={cn(
              "size-2 rounded-full",
              running ? "animate-pulse bg-amber-500" : "bg-muted-foreground/40",
            )}
          />
          {status}
        </span>
      }
    >
      {branch === null ? null : (
        <p className="truncate font-mono text-[11px] text-muted-foreground/80">{branch}</p>
      )}
    </PanelSummaryCard>
  );
}

function ThreadSummary({ threadId, label }: { readonly threadId: string; readonly label: string }) {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const ref = useMemo(
    () => (environmentId === null ? null : scopeThreadRef(environmentId, ThreadId.make(threadId))),
    [environmentId, threadId],
  );
  // The shell, never the detail: the shell is metadata the board already
  // streams, and the detail is the transcript this tier exists not to load.
  const shell = useThreadShell(ref);

  if (environmentId === null) return <PanelSummaryCard title={label} line="No environment." />;
  if (shell === null) return <PanelSummaryCard title={label} line="No such thread here." />;

  const turn = shell.latestTurn;
  const running = turn !== null && turn.completedAt === null;
  return (
    <ThreadSummaryView
      title={shell.title}
      status={turn === null ? "No turn yet" : `${running ? "Running" : "Idle"} · ${turn.state}`}
      running={running}
      branch={shell.branch}
    />
  );
}
