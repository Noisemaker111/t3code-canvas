import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type {
  EnvironmentId,
  KanbanCard,
  KanbanCardHistoryEntry,
  ComponentId,
  KanbanPrChecks,
  KanbanPrepStatus,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { KanbanCardId, ProviderInstanceId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  CheckIcon,
  ChevronDownIcon,
  ClipboardIcon,
  HistoryIcon,
  Loader2Icon,
  PlusIcon,
  SettingsIcon,
  SparklesIcon,
} from "lucide-react";
import {
  createContext,
  Fragment,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { buildThreadTurnInterruptInput } from "../ChatView.logic";

import { cn } from "~/lib/utils";
import { cardThreadStationSearch } from "~/lib/cardThreadStation";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { groupCardsByColumn, useKanbanCards, useKanbanCommands } from "../../state/kanban";
import { stationKey } from "../canvas/panels/panelStations";
import { usePromptAssist } from "../../state/promptAssist";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import {
  createShapeId,
  renderPlaintextFromRichText,
  toRichText,
  useValue,
  type Editor,
  type TLShapeId,
  type TLTextShape,
} from "tldraw";

import {
  issueRefFromDrag,
  prRefFromDrag,
  resolveIssueRefDrop,
  resolvePrRefDrop,
  type IssueRef,
  type PrRef,
} from "../canvas/refDrops";
import {
  boardRulePolicy,
  cardRendererFor,
  resolveArrival,
  type CardRenderer,
} from "@t3tools/shared/boardRules";
import { explainMoveBlock } from "@t3tools/shared/moveGate";
import { latestLayer } from "@t3tools/shared/cardFacts";
import {
  boardColumn,
  boardColumns,
  decodeColumnPanels,
  distinctColumnIds,
  encodeColumnPanels,
  type BoardColumnView,
} from "../canvas/panels/boardColumns";
import { columnPanelEntries, panelShapes, setPanelTitle } from "../canvas/panels/PanelShapeUtil";
import { panelIdentity } from "../canvas/panels/panelStations";
import {
  readAlwaysOnSkillIds,
  readBoardSettings,
  subscribeBoardSettings,
  toggleAlwaysOnSkillId,
} from "../../lib/boardSettings";
import { ColumnRulesDialog } from "./ColumnRulesDialog";
import { KanbanCardAttachments } from "./KanbanCardAttachments";
import {
  BOTTOM_ABOVE_CAPTURE_BAR,
  BOTTOM_ABOVE_DROP_ZONE,
  boardNeedsLiveQueueClock,
  countQueuedCards,
  describeCardQueue,
  describePrChecks,
  cardElapsedMs,
  formatTimeInColumn,
  formatTokenCount,
  isLiveHermesWorking,
  type BoardQueueContext,
  type CardQueueState,
  type PrCheckBadge,
  clientAutoSkillsEnabled,
  planBoardHermesClientPass,
  resolveBoardSkillInstanceId,
  resolveBoardSkillModelSelection,
  prepStatusAfterSkillsFailure,
  prepStatusAfterSkillsPromote,
  prepStatusAfterSkillsStayInDraft,
  prepStatusOf,
  toBoardHermesCardSlice,
} from "./KanbanBoard.logic";
import { resolveBoardSkillPipeline, runSkillPipeline } from "../../lib/boardSkills";
import { isCoreBoardSkillId } from "../settings/skillCommands/skillCommandsPage.logic";
import { useCompactLayout } from "../canvas/panels/compactLayout";
import { PanelMenuItem, usePanelTitleBarActive } from "../canvas/panels/PanelChrome";
import { useProviderInstancePicker } from "../settings/InstanceModelSelect";
import { BaseBranchPicker } from "./BaseBranchPicker";
import { CardView, DraftWorkingDot } from "./CardTileView";
import { BoardModelPicker } from "./ComposerModelPreset";
import { PromptHistoryButton } from "./PromptHistoryButton";
import { threadsForLaunch } from "../../lib/threadBlocks";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { usePrimarySettings } from "../../hooks/useSettings";
import { useUsageSnapshot } from "../../hooks/useUsageSnapshot";
import { providerUsageUnusableReason } from "../../lib/providerUsage";
import { useHermesPing } from "../../lib/hermesPing";
import { useNowMs } from "../../lib/useNowMs";
import { parsePullRequestNumber } from "../../pullRequestReference";
import * as DateTime from "effect/DateTime";
import { findThreadRef, useProjects, useThread } from "../../state/entities";
import { usePrimaryEnvironment } from "../../state/environments";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { useConfirm } from "../ui/useConfirm";

/**
 * Everything a column panel needs from the board, provided once above the
 * whole panel layer. The columns are separate canvas panels in separate DOM
 * islands; one provider (and one DndContext inside it) is what lets a card
 * drag from any of them to any other.
 */
interface BoardContextValue {
  readonly environmentId: EnvironmentId | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly grouped: ReadonlyMap<ComponentId, ReadonlyArray<KanbanCard>>;
  /**
   * The columns this board has, in the order they stand on the canvas — the
   * `column` panels, plus any id the cards are sitting in with no panel yet.
   * One answer for every surface that draws a column.
   */
  readonly columns: ReadonlyArray<BoardColumnView>;
  readonly openCard: (card: KanbanCard) => void;
  readonly createDraft: () => void;
  /** Open the column's rules sheet — the gear on every column panel. */
  readonly openColumnRules: (column: ComponentId) => void;
  readonly projectTitleById: ReadonlyMap<string, string>;
  readonly modelLabelFor: (selection: { instanceId: string; model: string }) => string;
  readonly hermesWorkingIds: ReadonlySet<string>;
  readonly queueContext: BoardQueueContext;
  readonly prChecksById: ReadonlyMap<string, KanbanPrChecks>;
  readonly nowMs: number;
}

const BoardContext = createContext<BoardContextValue | null>(null);

export function useBoardContext(): BoardContextValue | null {
  return useContext(BoardContext);
}

/**
 * One column's name and id, live. Outside a board provider — the dev gallery —
 * a column still describes itself from its id rather than rendering blank.
 */
export function useBoardColumnView(id: string): BoardColumnView {
  return boardColumn(useBoardContext()?.columns ?? [], id);
}

/**
 * The board's columns, read off the canvas: the `column` panels in the order
 * they stand, plus any id the cards carry that no panel is standing for.
 *
 * Serialized through a string the way `PanelLayer` reads its entries, and for
 * the same reason: the reactive read touches every shape on the page, so a
 * stroke of a drawing would otherwise re-render the whole board.
 */
function useCanvasBoardColumns(
  editor: Editor | null,
  cards: ReadonlyArray<KanbanCard>,
): ReadonlyArray<BoardColumnView> {
  const encoded = useValue(
    "column panels",
    () => (editor === null ? "" : encodeColumnPanels(columnPanelEntries(editor))),
    [editor],
  );
  const cardColumns = distinctColumnIds(cards.map((card) => card.at)).join("\u0000");
  return useMemo(
    () =>
      boardColumns({
        panels: decodeColumnPanels(encoded),
        cardColumns: cardColumns.length === 0 ? [] : cardColumns.split("\u0000"),
      }),
    [encoded, cardColumns],
  );
}

function cardPrompt(card: KanbanCard): string {
  return card.body.trim() || (/^new draft$/i.test(card.title.trim()) ? "" : card.title);
}

/** A prompt with nothing written in it yet: the headline is a hint, not a title. */
export function cardIsPlaceholder(card: KanbanCard): boolean {
  return card.at === "prompts" && cardPrompt(card).length === 0;
}

const SECTION_HEADER_RE =
  /^(mission|why it matters|work to do|constraints|done when|open questions|summary|card summary)\s*:?\s*$/i;

/**
 * One-line title for the board card. Prefers a structure "card summary" first line;
 * never uses bare section headers like "Mission".
 */
function promptTitle(raw: string): string {
  const lines = raw
    .trim()
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (SECTION_HEADER_RE.test(line)) continue;
    if (line.length < 12) continue;
    return line.replace(/^(card summary|summary)\s*:\s*/i, "").slice(0, 160);
  }
  return (lines[0] ?? "Prompt").slice(0, 160);
}

/** One-sentence summary shown on the board face. */
export function cardDisplay(card: KanbanCard): string {
  const body = card.body.trim();
  const storedTitle = card.title.trim();
  const fromBody = body ? promptTitle(body) : "";
  const headline =
    storedTitle &&
    storedTitle.length >= 12 &&
    !SECTION_HEADER_RE.test(storedTitle) &&
    !/^new draft$/i.test(storedTitle)
      ? storedTitle
      : fromBody || storedTitle || "Prompt";

  return headline.slice(0, 160);
}

/** Columns where a linked thread is live work, so the face carries its run chrome. */
function cardRunsAThread(card: KanbanCard): boolean {
  return Boolean(card.threadId) && (card.at === "active" || card.at === "pr" || card.at === "done");
}

/**
 * Whether the card can reach its conversation at all. A thread does not stop
 * being this card's thread because the card moved back a column, so the record
 * links to it from every stage — even where a click edits the prompt instead.
 */
function cardHasThread(card: KanbanCard): boolean {
  return Boolean(card.threadId);
}

function projectDisplayName(project: {
  id: string;
  title: string;
  workspaceRoot: string;
  repositoryIdentity?: { displayName?: string; name?: string } | null | undefined;
}): string {
  if (project.title !== project.id && !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(project.title)) {
    return project.title;
  }
  const repositoryName =
    project.repositoryIdentity?.displayName ?? project.repositoryIdentity?.name;
  if (repositoryName) return repositoryName;
  return project.workspaceRoot.split(/[\\/]/).filter(Boolean).pop() ?? project.title;
}

/** The card's live turn, for the stop button. The status line says the rest. */
function useThreadStatus(card: KanbanCard): {
  running: boolean;
  thread: ReturnType<typeof useThread>;
} | null {
  const primary = usePrimaryEnvironment();
  const threadRef = useMemo(() => {
    if (!card.threadId) return null;
    const byId = findThreadRef(card.threadId as ThreadId);
    if (byId) return byId;
    if (primary?.environmentId) {
      return scopeThreadRef(primary.environmentId, card.threadId as ThreadId);
    }
    return null;
  }, [card.threadId, primary?.environmentId]);
  const thread = useThread(threadRef);

  if (!card.threadId || !thread) return null;
  const status = thread.session?.status;
  return { running: status === "running" || status === "starting", thread };
}

/**
 * The face this column draws its cards with, live: the rules dialog writes the
 * `display` row into board settings, and the column redraws without a refresh.
 */
function useColumnCardRenderer(column: ComponentId): CardRenderer {
  const [renderer, setRenderer] = useState<CardRenderer>(() =>
    cardRendererFor(readBoardSettings(), column),
  );
  useEffect(
    () => subscribeBoardSettings((settings) => setRenderer(cardRendererFor(settings, column))),
    [column],
  );
  return renderer;
}

function CardTile({
  card,
  onOpen,
  projectLabel,
  modelLabelFor,
  hermesWorking,
  hermesEnabled,
  queueState,
  prChecks,
  nowMs,
  renderer,
}: {
  card: KanbanCard;
  onOpen: (card: KanbanCard) => void;
  projectLabel?: string | null;
  modelLabelFor: (selection: { instanceId: string; model: string }) => string;
  hermesWorking?: boolean;
  hermesEnabled: boolean;
  queueState?: CardQueueState | null;
  prChecks?: KanbanPrChecks | null;
  nowMs: number;
  renderer: CardRenderer;
}) {
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const threadStatus = useThreadStatus(card);
  const showThreadChrome = cardRunsAThread(card) && threadStatus !== null;
  const liveWorking = isLiveHermesWorking(Boolean(hermesWorking));
  const working = liveWorking || card.hermesOperation?.status === "running";
  const primary = usePrimaryEnvironment();
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const canStop = Boolean(showThreadChrome && threadStatus?.running);
  const onStop = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
      if (!threadStatus?.thread || !primary?.environmentId) return;
      void interruptThreadTurn({
        environmentId: primary.environmentId,
        input: buildThreadTurnInterruptInput(threadStatus.thread),
      });
    },
    [threadStatus?.thread, primary?.environmentId, interruptThreadTurn],
  );
  const { ping, pendingCardId } = useHermesPing();
  const onPing = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
      void ping({ cardId: card.id, title: cardDisplay(card), hermesEnabled });
    },
    [card, hermesEnabled, ping],
  );
  const routeUsage = card.modelRouteUsage;
  const estimateLabel =
    routeUsage?.lowPercent !== null &&
    routeUsage?.lowPercent !== undefined &&
    routeUsage.highPercent !== null
      ? `≈${routeUsage.lowPercent}–${routeUsage.highPercent}%`
      : routeUsage?.likelyPercent !== null && routeUsage?.likelyPercent !== undefined
        ? `≈${routeUsage.likelyPercent}%`
        : null;
  // Same slot, two lives: the route forecast until the thread has spent
  // anything, then what it actually spent. A measured number retires its guess.
  const usageLabel = card.tokenUsage
    ? `${formatTokenCount(card.tokenUsage.totalTokens)} tok`
    : estimateLabel;
  const routeSource = card.modelRouteProvenance?.source === "hermes" ? "Hermes" : null;
  const chosenModel = card.modelSelection ? modelLabelFor(card.modelSelection) : null;
  const modelLabel =
    chosenModel === null
      ? null
      : [routeSource, chosenModel, usageLabel].filter((part) => part !== null).join(" · ");
  // The face reads from the newest layer the card has grown. A card sent back
  // from PR to fix red CI keeps its pull request, and its checks are the thing
  // worth seeing while it is being fixed.
  const showsPr = latestLayer(card) === "pr";
  const ciBadge = describePrChecks(prChecks, showsPr);
  const checkUrl = prChecks?.failingUrl ?? card.prUrl;
  // The moving pixels are the provider's DragOverlay, drawn in screen space —
  // a transform applied here would be scaled again by the canvas zoom the
  // panel is rendered under, so the tile only dims while its ghost travels.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: card.id,
    data: { at: card.at },
    disabled: working,
  });

  const placeholder = cardIsPlaceholder(card);
  const prNumber = card.prNumber ?? parsePullRequestNumber(card.prUrl);
  const enteredAt = card.columnEnteredAt ?? card.createdAt;

  return (
    <CardView
      renderer={renderer}
      headline={
        placeholder ? "Write a prompt..." : ((showsPr ? card.prTitle : null) ?? cardDisplay(card))
      }
      placeholder={placeholder}
      projectLabel={projectLabel}
      modelLabel={modelLabel}
      working={working}
      queueState={queueState}
      timeInColumn={
        placeholder ? null : formatTimeInColumn(nowMs - DateTime.toEpochMillis(enteredAt))
      }
      ruleMove={card.lastRuleMove?.rule ?? null}
      prChecks={ciBadge}
      prChecksUrl={checkUrl}
      prUrl={card.prUrl}
      prNumber={prNumber}
      onStop={canStop ? onStop : null}
      onPing={placeholder ? null : onPing}
      pinging={pendingCardId === card.id}
      dragging={isDragging}
      containerRef={setNodeRef}
      containerProps={{
        ...listeners,
        ...attributes,
        onPointerDown: (event) => {
          pointerStartRef.current = { x: event.clientX, y: event.clientY };
          listeners?.onPointerDown?.(event);
        },
        onClick: (event) => {
          const start = pointerStartRef.current;
          pointerStartRef.current = null;
          if (!start) return;
          if (Math.abs(event.clientX - start.x) > 6 || Math.abs(event.clientY - start.y) > 6) {
            return;
          }
          if (isDragging) return;
          onOpen(card);
        },
      }}
    />
  );
}

const ARCHIVE_DROP_ID = "__archive__";

/** Bottom-left drop target: drag a card here to take it off the board. */
function ArchiveDropZone() {
  const { setNodeRef, isOver } = useDroppable({
    id: ARCHIVE_DROP_ID,
    data: { archive: true },
  });
  return (
    <div
      ref={setNodeRef}
      data-kanban-archive=""
      className={cn(
        "pointer-events-auto flex items-center gap-2 rounded-xl border border-dashed px-3 py-1.5 text-[11px] font-medium shadow-sm transition-colors",
        isOver
          ? "border-amber-500 bg-amber-500/15 text-amber-800 dark:text-amber-200"
          : "border-border/70 bg-card/95 text-muted-foreground",
      )}
    >
      <ArchiveIcon className="size-3.5" />
      {isOver ? "Drop to archive" : "Archive"}
    </div>
  );
}

/**
 * Count / history / + / settings for a column — same controls whether they sit
 * in the panel title bar (with the centered name) or in the column's own header
 * when that bar is chromeless.
 */
/** How many cards are in the column, and how many of them are waiting on Hermes. */
function ColumnCounts({
  cardCount,
  queuedCount,
  compact = false,
}: {
  readonly cardCount: number;
  readonly queuedCount: number;
  readonly compact?: boolean;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {compact ? null : (
        <span className="bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
          {cardCount}
        </span>
      )}
      {queuedCount > 0 ? (
        <span
          title={`${queuedCount} card${queuedCount === 1 ? "" : "s"} waiting for the Hermes queue`}
          className="inline-flex items-center gap-1 bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 tabular-nums dark:text-sky-300"
        >
          <span className="size-1.5 animate-pulse rounded-full bg-current" />
          {queuedCount} queued
        </span>
      ) : null}
    </span>
  );
}

/**
 * The count a column panel wears at the head of its title bar, where the drag
 * grip used to sit — the bar is the handle, so the mark can say something.
 */
export function ColumnChromeBadge({ column }: { readonly column: string }) {
  const board = useBoardContext();
  const resolved = column;
  if (board === null) return null;
  const cards = board.grouped.get(resolved) ?? [];
  return (
    <ColumnCounts
      cardCount={cards.length}
      queuedCount={countQueuedCards(cards.map(toBoardHermesCardSlice), {
        liveSkillJobIds: board.hermesWorkingIds,
        context: board.queueContext,
      })}
    />
  );
}

function ColumnHeaderActions({
  column,
  cardCount,
  queuedCount,
  compact = false,
  chrome = false,
  focused = false,
  onAddDraft,
  onOpenSettings,
}: {
  readonly column: ComponentId;
  readonly cardCount: number;
  readonly queuedCount: number;
  readonly compact?: boolean;
  /** Title-bar placement: match the frame settings cog control. */
  readonly chrome?: boolean;
  readonly focused?: boolean;
  readonly onAddDraft?: (() => void) | undefined;
  readonly onOpenSettings?: (() => void) | undefined;
}) {
  const meta = useBoardColumnView(column);
  const controlClass = chrome
    ? cn(
        "inline-flex items-center justify-center rounded",
        "pointer-coarse:relative pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11",
        focused
          ? "size-6 border border-border bg-background text-foreground hover:bg-accent"
          : "size-5 text-muted-foreground hover:bg-accent hover:text-foreground",
      )
    : "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

  return (
    <div className="flex shrink-0 items-center gap-1">
      {chrome ? null : (
        <ColumnCounts
          cardCount={cardCount}
          queuedCount={queuedCount}
          {...(compact ? { compact } : {})}
        />
      )}
      {column === "prompts" ? <PromptHistoryButton /> : null}
      {column === "prompts" && onAddDraft ? (
        <button
          type="button"
          onClick={onAddDraft}
          title="New draft"
          aria-label="New draft"
          className={controlClass}
          onPointerDown={chrome ? (event) => event.stopPropagation() : undefined}
          onDoubleClick={chrome ? (event) => event.stopPropagation() : undefined}
        >
          <PlusIcon className="size-3.5" />
        </button>
      ) : null}
      {onOpenSettings ? (
        <button
          type="button"
          onClick={onOpenSettings}
          title={`${meta.title} rules`}
          aria-label={`${meta.title} rules`}
          className={controlClass}
          onPointerDown={chrome ? (event) => event.stopPropagation() : undefined}
          onDoubleClick={chrome ? (event) => event.stopPropagation() : undefined}
        >
          <SettingsIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Column history / + for the panel title bar. The rules live in the bar's cog
 * menu instead ({@link ColumnChromeMenu}), so a column wears one cog, not two.
 */
export function ColumnChromeSettings({
  column,
  focused = false,
}: {
  readonly column: string;
  readonly focused?: boolean;
}) {
  const board = useBoardContext();
  const resolved = column;
  if (board === null) return null;
  const cards = board.grouped.get(resolved) ?? [];
  const queuedCount = countQueuedCards(cards.map(toBoardHermesCardSlice), {
    liveSkillJobIds: board.hermesWorkingIds,
    context: board.queueContext,
  });
  return (
    <ColumnHeaderActions
      column={resolved}
      cardCount={cards.length}
      queuedCount={queuedCount}
      chrome
      focused={focused}
      {...(resolved === "prompts" ? { onAddDraft: board.createDraft } : {})}
    />
  );
}

/** The column's rules, as a row in the panel title bar's cog menu. */
export function ColumnChromeMenu({ column }: { readonly column: string }) {
  const board = useBoardContext();
  const meta = useBoardColumnView(column);
  if (board === null) return null;
  return (
    <PanelMenuItem testId={`column-${column}-rules`} onClick={() => board.openColumnRules(column)}>
      {`${meta.title} rules`}
    </PanelMenuItem>
  );
}

function Column({
  column,
  cards,
  onOpen,
  onAddDraft,
  projectTitleById,
  modelLabelFor,
  hermesWorkingIds,
  queueContext,
  prChecksById,
  nowMs,
  compact = false,
  fill = false,
  onOpenSettings,
}: {
  column: ComponentId;
  cards: ReadonlyArray<KanbanCard>;
  prChecksById: ReadonlyMap<string, KanbanPrChecks>;
  onOpen: (card: KanbanCard) => void;
  onAddDraft?: () => void;
  projectTitleById: ReadonlyMap<string, string>;
  modelLabelFor: (selection: { instanceId: string; model: string }) => string;
  hermesWorkingIds: ReadonlySet<string>;
  queueContext: BoardQueueContext;
  nowMs: number;
  /** The only column on screen, so it takes the width and drops its title. */
  compact?: boolean;
  /** The column is a panel of its own: take the panel's width, whose header already names it. */
  fill?: boolean;
  /** Opens the column's rules sheet — the gear. */
  onOpenSettings?: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column, data: { column } });
  const meta = useBoardColumnView(column);
  const cardRenderer = useColumnCardRenderer(column);
  const titleBarActive = usePanelTitleBarActive();
  // Panel title bar already owns the name + count / + / settings when present.
  const headerInChrome = fill && titleBarActive;
  const queuedCount = countQueuedCards(cards.map(toBoardHermesCardSlice), {
    liveSkillJobIds: hermesWorkingIds,
    context: queueContext,
  });

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-1 flex-col",
        compact || fill ? "w-full" : "min-w-[15rem] max-w-[22rem]",
      )}
    >
      {headerInChrome ? null : (
        <div className="relative mb-2 flex min-h-6 items-center gap-1 px-2">
          <div className="flex min-w-0 flex-1 items-center" />
          {compact ? null : (
            <span className="pointer-events-none absolute inset-x-0 text-center text-[13px] font-semibold text-foreground">
              {meta.title}
            </span>
          )}
          <div className="relative z-10 flex flex-1 items-center justify-end">
            <ColumnHeaderActions
              column={column}
              cardCount={cards.length}
              queuedCount={queuedCount}
              compact={compact}
              onOpenSettings={onOpenSettings}
              {...(onAddDraft ? { onAddDraft } : {})}
            />
          </div>
        </div>
      )}
      <div
        ref={setNodeRef}
        data-kanban-column={column}
        className={cn(
          // No box of its own: the panel around it already is the column, and a
          // dashed rectangle inside a bordered panel reads as a third frame. A
          // drag says where it will land with a tint instead.
          "flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 transition-colors",
          isOver && "bg-primary/5",
        )}
      >
        {cards.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground/60">No cards</p>
        ) : (
          cards.map((card) => (
            <CardTile
              key={card.id}
              card={card}
              onOpen={onOpen}
              renderer={cardRenderer}
              modelLabelFor={modelLabelFor}
              hermesWorking={hermesWorkingIds.has(card.id)}
              hermesEnabled={queueContext.brainEnabled}
              nowMs={nowMs}
              prChecks={prChecksById.get(card.id) ?? null}
              queueState={describeCardQueue({
                card: toBoardHermesCardSlice(card),
                hasLiveSkillJob: hermesWorkingIds.has(card.id),
                context: queueContext,
              })}
              projectLabel={
                card.projectId ? (projectTitleById.get(card.projectId) ?? "Assigned project") : null
              }
            />
          ))
        )}
      </div>
    </div>
  );
}

function historyKindLabel(kind: KanbanCardHistoryEntry["kind"]): string {
  switch (kind) {
    case "created":
      return "Created";
    case "body_edit":
      return "Body edit";
    case "skill":
      return "Skill";
    case "polish":
      return "Polish";
    case "promote":
      return "Moved to Prompts";
    case "column_move":
      return "Column move";
    case "launch":
      return "Launch";
    case "error":
      return "Error";
    default:
      return kind;
  }
}

function CardHistoryDialog({
  card,
  open,
  onOpenChange,
  listHistory,
}: {
  card: KanbanCard | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  listHistory: (cardId: KanbanCard["id"]) => Promise<ReadonlyArray<KanbanCardHistoryEntry>>;
}) {
  const [entries, setEntries] = useState<ReadonlyArray<KanbanCardHistoryEntry>>([]);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !card) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void listHistory(card.id)
      .then((next) => {
        if (!cancelled) setEntries(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "Could not load history.");
          setEntries([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [card, listHistory, open]);

  if (!card) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl" showCloseButton>
        <DialogHeader className="gap-1 p-4 pb-2 sm:p-5 sm:pb-2">
          <DialogTitle className="text-base">Prompt history</DialogTitle>
          <p className="text-xs text-muted-foreground">
            Permanent trail — original prompt, each skill input/output, edits. Kept after delete.
          </p>
        </DialogHeader>
        <DialogPanel scrollFade className="max-h-[70vh] px-4 py-2 sm:px-5">
          {loading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" /> Loading history…
            </div>
          ) : loadError ? (
            <p className="py-6 text-sm text-destructive">{loadError}</p>
          ) : entries.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">No history yet for this card.</p>
          ) : (
            <ol className="space-y-2 pb-4">
              {entries.map((entry, index) => {
                const expanded = expandedId === entry.id;
                const title =
                  entry.kind === "skill" || entry.kind === "polish"
                    ? `${historyKindLabel(entry.kind)}${entry.skillId ? ` /${entry.skillId}` : ""}`
                    : historyKindLabel(entry.kind);
                return (
                  <li
                    key={entry.id}
                    className="rounded-lg border border-border/70 bg-card/40 text-sm"
                  >
                    <button
                      type="button"
                      className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-accent/40"
                      onClick={() => setExpandedId(expanded ? null : entry.id)}
                    >
                      <span className="mt-0.5 w-5 shrink-0 tabular-nums text-[11px] text-muted-foreground">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="font-medium text-foreground">{title}</span>
                        {entry.errorText ? (
                          <span className="mt-0.5 block text-[11px] text-destructive">
                            {entry.errorText}
                          </span>
                        ) : null}
                        <span className="mt-0.5 block text-[10px] text-muted-foreground">
                          {DateTime.formatIso(entry.createdAt)}
                        </span>
                      </span>
                      <ChevronDownIcon
                        className={cn(
                          "mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform",
                          expanded && "rotate-180",
                        )}
                      />
                    </button>
                    {expanded ? (
                      <div className="space-y-2 border-t border-border/60 px-3 py-2">
                        {entry.inputText ? (
                          <div>
                            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                              Input
                            </p>
                            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-[11px] leading-relaxed text-foreground">
                              {entry.inputText}
                            </pre>
                          </div>
                        ) : null}
                        {entry.outputText ? (
                          <div>
                            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                              Output
                            </p>
                            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-[11px] leading-relaxed text-foreground">
                              {entry.outputText}
                            </pre>
                          </div>
                        ) : null}
                        {entry.meta ? (
                          <div>
                            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                              Meta
                            </p>
                            <pre className="overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-[11px] text-muted-foreground">
                              {JSON.stringify(entry.meta, null, 2)}
                            </pre>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function recordStamp(at: DateTime.Utc): string {
  return new Date(DateTime.toEpochMillis(at)).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Everything the card carries about its own run, at every column: the stages it
 * reached, how long creation → ship took, what the thread spent, and the way
 * back into that conversation. A card in Prompts shows the same block with
 * fewer rows filled — the record never depends on where the card sits.
 */
function CardRecord({
  card,
  onOpenThread,
}: {
  card: KanbanCard;
  onOpenThread: (card: KanbanCard) => void;
}) {
  const nowMs = useNowMs(15_000);
  const usage = card.tokenUsage;
  const prNumber = card.prNumber ?? parsePullRequestNumber(card.prUrl);
  const rows: Array<{ label: string; value: string; href?: string }> = [
    { label: "Created", value: recordStamp(card.createdAt) },
  ];
  if (card.timeline.launchedAt)
    rows.push({ label: "Launched", value: recordStamp(card.timeline.launchedAt) });
  if (card.timeline.prOpenedAt)
    rows.push({ label: "PR opened", value: recordStamp(card.timeline.prOpenedAt) });
  if (card.timeline.shippedAt)
    rows.push({ label: "Shipped", value: recordStamp(card.timeline.shippedAt) });
  rows.push({
    label: card.timeline.shippedAt ? "Took" : "Open",
    value: formatTimeInColumn(cardElapsedMs(card, nowMs)),
  });
  if (usage)
    rows.push({
      label: "Tokens",
      value: `${formatTokenCount(usage.totalTokens)} · ${formatTokenCount(usage.inputTokens)} in · ${formatTokenCount(usage.outputTokens)} out`,
    });
  // A card adopted from an open pull request has no prompt to read — its body
  // is the link it arrived as. The PR it stands for is the record it does have.
  if (card.prUrl)
    rows.push({
      label: "Pull",
      value: [prNumber === null ? null : `#${prNumber}`, card.prTitle].filter(Boolean).join(" · "),
      href: card.prUrl,
    });

  return (
    <div className="mt-3 border-t border-border/60 pt-2">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
        {rows.map((row) => (
          <Fragment key={row.label}>
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="min-w-0 truncate text-foreground tabular-nums">
              {row.href ? (
                <a
                  href={row.href}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                  onClick={(event) => event.stopPropagation()}
                >
                  {row.value || row.href}
                </a>
              ) : (
                row.value
              )}
            </dd>
          </Fragment>
        ))}
      </dl>
      {cardHasThread(card) ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2 w-full"
          onClick={() => onOpenThread(card)}
        >
          Open conversation
        </Button>
      ) : null}
    </div>
  );
}

function CardDetailDialog({
  card,
  open,
  onOpenChange,
  onSave,
  onOpenThread,
  onRunSkills,
  onPromoteToPrompts,
  onMoveColumn,
  onArchive,
  isSaving,
  isRunningSkills,
  skills,
  alwaysOnIds,
  onToggleAlwaysOn,
  projects,
  environmentId,
  onOpenHistory,
}: {
  card: KanbanCard | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (
    card: KanbanCard,
    nextPrompt: string,
    fields: {
      projectId: ProjectId | null;
      modelSelection: { instanceId: ProviderInstanceId; model: string } | null;
      baseBranch: string | null;
    },
  ) => Promise<void>;
  onOpenThread: (card: KanbanCard) => void;
  onRunSkills: (card: KanbanCard, currentText: string) => Promise<void>;
  onPromoteToPrompts: (card: KanbanCard, currentText: string) => Promise<void>;
  /** The move a drag would have made. Touch has nowhere to drop a card. */
  onMoveColumn: (card: KanbanCard, column: ComponentId) => void;
  onArchive: (card: KanbanCard) => void;
  isSaving: boolean;
  isRunningSkills: boolean;
  skills: ReadonlyArray<{ id: string; prompt: string }>;
  alwaysOnIds: ReadonlyArray<string>;
  onToggleAlwaysOn: (id: string, enabled: boolean) => void;
  projects: ReadonlyArray<{
    id: string;
    title: string;
    workspaceRoot: string;
    defaultBaseBranch?: string | null | undefined;
  }>;
  environmentId: EnvironmentId | null;
  onOpenHistory: () => void;
}) {
  const [value, setValue] = useState("");
  const [copied, setCopied] = useState(false);
  const [projectId, setProjectId] = useState<string>("");
  const [instanceId, setInstanceId] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [baseBranch, setBaseBranch] = useState<string>("");
  const compact = useCompactLayout();
  const busy = isSaving || isRunningSkills;
  const boardColumnList = useBoardContext()?.columns ?? [];
  const moveTargets = boardColumnList.filter((entry) => entry.id !== card?.at);

  useEffect(() => {
    if (card && open) {
      setValue(cardPrompt(card));
      setCopied(false);
      setProjectId(card.projectId ?? "");
      setInstanceId(card.modelSelection?.instanceId ?? "");
      setModel(card.modelSelection?.model ?? "");
      setBaseBranch(card.baseBranch ?? "");
    }
  }, [card, open]);

  // Reflect async skill rewrites back into the editor.
  useEffect(() => {
    if (card && open && !isRunningSkills) {
      setValue(cardPrompt(card));
      setProjectId(card.projectId ?? "");
      setInstanceId(card.modelSelection?.instanceId ?? "");
      setModel(card.modelSelection?.model ?? "");
      setBaseBranch(card.baseBranch ?? "");
    }
  }, [
    card?.baseBranch,
    card?.body,
    card?.id,
    card?.modelSelection,
    card?.projectId,
    isRunningSkills,
    open,
  ]);

  if (!card) return null;

  const trimmed = value.trim();
  const selectedModel =
    instanceId && model ? { instanceId: ProviderInstanceId.make(instanceId), model } : null;
  const nextProjectId = projectId.trim().length > 0 ? (projectId.trim() as ProjectId) : null;
  const selectedProject = projects.find((entry) => entry.id === nextProjectId) ?? null;
  const nextBaseBranch = baseBranch.trim().length > 0 ? baseBranch.trim() : null;
  const fieldsDirty =
    (card.baseBranch ?? "") !== (nextBaseBranch ?? "") ||
    (card.projectId ?? "") !== (nextProjectId ?? "") ||
    `${card.modelSelection?.instanceId ?? ""}::${card.modelSelection?.model ?? ""}` !==
      (selectedModel ? `${selectedModel.instanceId}::${selectedModel.model}` : "::");
  const dirty = trimmed !== cardPrompt(card).trim() || fieldsDirty;
  const canSave = trimmed.length > 0 && dirty && !busy;
  const alwaysOnSet = new Set(alwaysOnIds);
  const selectClassName = cn(
    "h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground",
    "focus-visible:border-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl" showCloseButton>
        <DialogHeader className="gap-1 p-4 pb-2 sm:p-5 sm:pb-2">
          {/* Room for the popup's own close button, which sits in this corner. */}
          <div className="flex items-center gap-2 pe-8">
            <DialogTitle className="text-base">Edit Prompt</DialogTitle>
            {isRunningSkills ? <DraftWorkingDot /> : null}
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="ml-auto gap-1"
              disabled={busy}
              onClick={onOpenHistory}
            >
              <HistoryIcon className="size-3.5" />
              History
            </Button>
          </div>
        </DialogHeader>
        <DialogPanel scrollFade={false} className="px-4 py-2 sm:px-5">
          <div className="mb-3 grid gap-2 sm:grid-cols-2">
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Project
              </span>
              <select
                className={selectClassName}
                value={projectId}
                disabled={busy || projects.length === 0}
                aria-invalid={!nextProjectId}
                onChange={(event) => setProjectId(event.target.value)}
              >
                <option value="">Auto · Hermes selects</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {projectDisplayName(project)}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Model (optional pin)
              </span>
              <BoardModelPicker
                preset={instanceId && model ? { instanceId, model } : null}
                disabled={busy}
                triggerClassName="h-8 w-full max-w-none justify-between text-foreground/90"
                onChange={(next) => {
                  setInstanceId(next?.instanceId ?? "");
                  setModel(next?.model ?? "");
                }}
              />
            </div>
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Base branch
              </span>
              <BaseBranchPicker
                environmentId={environmentId}
                cwd={selectedProject?.workspaceRoot ?? null}
                value={baseBranch}
                inheritedLabel={selectedProject?.defaultBaseBranch ?? "repo default"}
                disabled={busy}
                className={selectClassName}
                onChange={setBaseBranch}
              />
            </label>
          </div>
          {card.modelRouteProvenance?.source === "hermes" &&
          (card.modelRouteReason || card.modelRouteUsage) ? (
            <details className="mb-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs">
              <summary className="cursor-pointer font-medium text-foreground">
                Why Hermes chose this route
              </summary>
              {card.modelRouteReason ? (
                <p className="mt-2 whitespace-pre-wrap leading-relaxed text-muted-foreground">
                  {card.modelRouteReason}
                </p>
              ) : null}
              {card.modelRouteUsage ? (
                <p className="mt-2 text-muted-foreground">
                  Expected usage:{" "}
                  {card.modelRouteUsage.lowPercent !== null &&
                  card.modelRouteUsage.highPercent !== null
                    ? `${card.modelRouteUsage.lowPercent}–${card.modelRouteUsage.highPercent}%`
                    : card.modelRouteUsage.likelyPercent !== null
                      ? `about ${card.modelRouteUsage.likelyPercent}%`
                      : "unknown until enough comparable tasks have been observed"}
                  {" · "}
                  {card.modelRouteUsage.basis}
                </p>
              ) : null}
            </details>
          ) : null}
          <div className="relative">
            <textarea
              value={value}
              onChange={(event) => setValue(event.target.value)}
              rows={compact ? 6 : 10}
              disabled={busy}
              className={cn(
                "w-full resize-y rounded-none border border-border bg-background px-3 py-2.5 pr-9 text-sm leading-relaxed text-foreground",
                "placeholder:text-muted-foreground/50 focus-visible:border-ring focus-visible:outline-none",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
              placeholder="Prompt text…"
            />
            <button
              type="button"
              aria-label={copied ? "Copied" : "Copy prompt"}
              disabled={busy || trimmed.length === 0}
              className={cn(
                "absolute top-2 right-2 inline-flex size-7 items-center justify-center text-muted-foreground transition-colors",
                "hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
              )}
              onClick={() => {
                void navigator.clipboard.writeText(trimmed).then(
                  () => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  },
                  () => toastManager.add({ type: "error", title: "Could not copy prompt" }),
                );
              }}
            >
              {copied ? (
                <CheckIcon className="size-3.5" />
              ) : (
                <ClipboardIcon className="size-3.5" strokeWidth={1.75} />
              )}
            </button>
          </div>
          {environmentId && card.attachments.length > 0 ? (
            <KanbanCardAttachments environmentId={environmentId} attachments={card.attachments} />
          ) : null}
          <CardRecord card={card} onOpenThread={onOpenThread} />
          {/* Every column a drag can reach, as buttons. Dragging between
              columns needs two columns on screen, and a phone shows one. */}
          <div className="mt-3 border-t border-border/60 pt-2">
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Move to
            </p>
            <div className="flex flex-wrap gap-1.5">
              {moveTargets.map((column) => (
                <Button
                  key={column.id}
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={busy}
                  onClick={() => {
                    onMoveColumn(card, column.id);
                    onOpenChange(false);
                  }}
                >
                  {column.title}
                </Button>
              ))}
            </div>
            {/* Its own row: taking the card off the board is not a fifth column
                to move it to. */}
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="mt-2 gap-1 text-destructive"
              disabled={busy}
              onClick={() => {
                onArchive(card);
                onOpenChange(false);
              }}
            >
              <ArchiveIcon className="size-3.5" />
              Archive
            </Button>
          </div>
        </DialogPanel>
        <DialogFooter
          variant="bare"
          className="flex-row flex-wrap items-center justify-between gap-2 border-t border-border/60 px-4 py-2.5 sm:px-5"
        >
          <div className="flex items-center gap-1">
            {/* Split control: primary Run skills + chevron for always-on toggles */}
            <div className="inline-flex items-stretch overflow-hidden rounded-md border border-border">
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={busy || trimmed.length === 0}
                className="gap-1 rounded-none border-0 border-r border-border shadow-none"
                onClick={() => {
                  void onRunSkills(card, value);
                }}
              >
                {isRunningSkills ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <SparklesIcon className="size-3.5" />
                )}
                {isRunningSkills ? "Applying…" : "Apply skills"}
                {!isRunningSkills && alwaysOnIds.length > 0 ? (
                  <span className="tabular-nums text-muted-foreground">({alwaysOnIds.length})</span>
                ) : null}
              </Button>
              <Popover>
                <PopoverTrigger
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={busy}
                      aria-label="Always-on skills"
                      className="rounded-none border-0 px-1.5 shadow-none"
                    />
                  }
                >
                  <ChevronDownIcon className="size-3.5 opacity-80" />
                </PopoverTrigger>
                <PopoverPopup
                  align="start"
                  side="top"
                  className="w-72"
                  viewportClassName="px-0 py-0 [--viewport-inline-padding:0px]"
                >
                  <div className="p-1.5">
                    <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Optional prompt transforms
                    </p>
                    {skills.length === 0 ? (
                      <p className="px-2 py-2 text-xs text-muted-foreground">
                        No global skills yet. Add Defaults in Settings → Board.
                      </p>
                    ) : (
                      <ul className="max-h-56 space-y-0.5 overflow-y-auto">
                        {skills.map((skill) => {
                          const core = isCoreBoardSkillId(skill.id);
                          const on = core || alwaysOnSet.has(skill.id);
                          return (
                            <li
                              key={skill.id}
                              className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="truncate font-mono text-[12px] font-medium">
                                    /{skill.id}
                                  </span>
                                  {core ? (
                                    <span className="rounded bg-muted px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                                      Core
                                    </span>
                                  ) : null}
                                </div>
                                <div className="truncate text-[10px] text-muted-foreground">
                                  {skill.prompt.slice(0, 80)}
                                </div>
                              </div>
                              <Switch
                                checked={on}
                                disabled={core}
                                onCheckedChange={(checked) => {
                                  if (core) return;
                                  onToggleAlwaysOn(skill.id, Boolean(checked));
                                }}
                                aria-label={
                                  core
                                    ? `Core skill /${skill.id} always runs`
                                    : `Always run /${skill.id}`
                                }
                              />
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    <p className="mt-1 border-t border-border/60 px-2 pt-1.5 text-[10px] leading-snug text-muted-foreground">
                      Routing: Hermes understand → project → execution → placement. These are
                      optional prompt transforms.
                    </p>
                  </div>
                </PopoverPopup>
              </Popover>
            </div>
            {card.at === "prompts" && prepStatusOf(card) !== "ready" ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={busy || trimmed.length === 0}
                onClick={() => {
                  void onPromoteToPrompts(card, value);
                }}
              >
                Mark ready
              </Button>
            ) : null}
          </div>
          <Button
            type="button"
            size="xs"
            disabled={!canSave}
            onClick={() => {
              void onSave(card, value, {
                projectId: nextProjectId,
                modelSelection: selectedModel,
                baseBranch: nextBaseBranch,
              });
            }}
          >
            {isSaving ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function KanbanBoardProvider({
  children,
  editor = null,
}: {
  readonly children: ReactNode;
  /** The live canvas, for mapping a drop back to the page. */
  readonly editor?: Editor | null;
}) {
  const { cards, environmentId, hermes, hermesBoard, prChecks, isPending, error, refresh } =
    useKanbanCards();
  const prChecksById = useMemo(
    () => new Map(prChecks.map((entry) => [entry.cardId as string, entry])),
    [prChecks],
  );
  const commands = useKanbanCommands(environmentId);
  const assist = usePromptAssist(environmentId);
  const skillCommands = usePrimarySettings((settings) => settings.skillCommands);
  const textGenerationModelSelection = usePrimarySettings(
    (settings) => settings.textGenerationModelSelection,
  );
  const usageSnapshot = useUsageSnapshot();
  const boardPicker = useProviderInstancePicker();
  const projects = useProjects();
  const navigate = useNavigate();
  const { defaultProjectRef } = useHandleNewThread();
  const { confirm, confirmDialog } = useConfirm();
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunningSkills, setIsRunningSkills] = useState(false);
  const [launchingActiveId, setLaunchingActiveId] = useState<string | null>(null);
  const [alwaysOnIds, setAlwaysOnIds] = useState<ReadonlyArray<string>>(() =>
    readAlwaysOnSkillIds(),
  );
  /** Draft → Prompts: pick skills before promote. */
  const [promoteSkillsCard, setPromoteSkillsCard] = useState<KanbanCard | null>(null);
  const [promoteSkillIds, setPromoteSkillIds] = useState<ReadonlyArray<string>>([]);
  /** Card ids with a background Hermes skill job in flight. */
  const [skillJobCardIds, setSkillJobCardIds] = useState<ReadonlyArray<string>>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [automation, setAutomation] = useState(() => {
    const settings = readBoardSettings();
    return {
      autoStructureDrafts: boardRulePolicy(settings).structureDrafts,
      autoMoveDraftsToPrompts: settings.hermesAutoMoveDraftsToPrompts,
      autoLaunchPrompts: boardRulePolicy(settings).launchPrompts,
    };
  });
  const skillJobsRef = useRef(new Set<string>());
  const autoSkillCardIdsRef = useRef(new Set<string>());
  const usageBlockedToastAtRef = useRef(0);

  const boardSlices = useMemo(() => cards.map(toBoardHermesCardSlice), [cards]);
  const needsQueueClock = useMemo(
    () =>
      boardNeedsLiveQueueClock(boardSlices, {
        brainEnabled: Boolean(hermesBoard?.enabled),
        ...automation,
        usageBlocked: false,
        busy: hermesBoard?.busy === true,
        nextTickAtMs: hermesBoard?.nextTickAt ? Date.parse(hermesBoard.nextTickAt) : null,
        nextModelCheckAtMs: hermesBoard?.nextModelCheckAt
          ? Date.parse(hermesBoard.nextModelCheckAt)
          : null,
        ...(hermesBoard?.cardActivity && hermesBoard.cardActivity.length > 0
          ? {
              activityByCardId: new Map(
                hermesBoard.cardActivity.map((entry) => [entry.cardId, entry]),
              ),
            }
          : {}),
        ...(hermesBoard?.cardWatch && hermesBoard.cardWatch.length > 0
          ? { watchByCardId: new Map(hermesBoard.cardWatch.map((entry) => [entry.cardId, entry])) }
          : {}),
      }),
    [automation, boardSlices, hermesBoard],
  );
  // The time-in-column line always needs a clock; only a countdown needs 1 Hz.
  const nowMs = useNowMs(needsQueueClock ? 1_000 : 15_000);
  const hermesWorkingIds = useMemo(() => new Set(skillJobCardIds), [skillJobCardIds]);

  // PR checks are independent of Hermes. Keep polling when the automation
  // loop is disabled so the background forge refresh can surface.
  useEffect(() => {
    if (!hermesBoard || hermesBoard.intervalMs <= 0) return;
    const everyMs = Math.min(hermesBoard.intervalMs, 10_000);
    const timer = window.setInterval(refresh, everyMs);
    return () => window.clearInterval(timer);
  }, [hermesBoard, refresh]);

  useEffect(
    () =>
      subscribeBoardSettings((settings) =>
        setAutomation({
          autoStructureDrafts: boardRulePolicy(settings).structureDrafts,
          autoMoveDraftsToPrompts: settings.hermesAutoMoveDraftsToPrompts,
          autoLaunchPrompts: boardRulePolicy(settings).launchPrompts,
        }),
      ),
    [],
  );

  // Do NOT auto-mirror sidebar threads into Draft cards. That turned every
  // historical thread into an empty Draft on login; with Hermes on, they all
  // got skill-processed and Delete was blocked while "Hermes working".
  // Board cards are created by Hermes / explicit board actions only.

  // Mouse and touch, not one pointer sensor for both. A pointer sensor arms on
  // the first touch, and the card has to declare `touch-action: none` for that
  // to be reliable — which is why a finger could not scroll the board at all.
  // A finger gets a hold-then-drag instead, so a plain swipe still scrolls.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
  );

  /** The card in flight, for the drag ghost and the archive target. */
  const [dragCard, setDragCard] = useState<KanbanCard | null>(null);
  /** The pull request row travelling, when the drag is a `pr-ref` and not a card. */
  const [dragPr, setDragPr] = useState<PrRef | null>(null);
  /** The issue row travelling, when the drag is an `issue-ref`. */
  const [dragIssue, setDragIssue] = useState<IssueRef | null>(null);
  /** The thread row travelling, when the drag is a `thread-ref`. */
  /** Which column's rules sheet is open. */
  const [rulesColumn, setRulesColumn] = useState<ComponentId | null>(null);

  const grouped = useMemo(() => groupCardsByColumn(cards), [cards]);
  const columns = useCanvasBoardColumns(editor, cards);
  /**
   * Rename a column: write the name onto its panel. There is nowhere else for
   * it to go — the panel is the column, so the name rides the canvas snapshot
   * with the box it names.
   */
  const renameColumn = useCallback(
    (column: ComponentId, title: string) => {
      if (editor === null) return;
      const panel = panelShapes(editor).get(panelIdentity({ kind: "column", entityId: column }));
      if (panel === undefined) return;
      setPanelTitle(editor, panel.id, title);
    },
    [editor],
  );
  const selectedCard = useMemo(
    () =>
      selectedCardId === null ? null : (cards.find((card) => card.id === selectedCardId) ?? null),
    [cards, selectedCardId],
  );

  useEffect(() => {
    if (selectedCardId === null) setHistoryOpen(false);
  }, [selectedCardId]);
  const projectTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) {
      map.set(project.id, projectDisplayName(project));
    }
    return map;
  }, [projects]);
  const modelLabelFor = useCallback(
    (selection: { instanceId: string; model: string }) => {
      const entry = boardPicker.findInstance(selection.instanceId);
      const option = boardPicker
        .modelOptionsFor(entry)
        .find((candidate) => candidate.slug === selection.model);
      const modelName = option?.shortName ?? option?.name ?? selection.model;
      return `${entry?.displayName ?? selection.instanceId} · ${modelName}`;
    },
    [boardPicker],
  );
  const globalSkills = useMemo(
    () =>
      Object.entries(skillCommands)
        .map(([id, command]) => ({ id, prompt: command.prompt }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    [skillCommands],
  );

  const moveCard = useCallback(
    (
      card: KanbanCard,
      targetColumn: ComponentId,
      extras?: { threadId?: string | null; prepStatus?: KanbanPrepStatus },
    ) => {
      const columnCards = grouped.get(targetColumn) ?? [];
      const lastPosition = columnCards.reduce((max, entry) => Math.max(max, entry.position), 0);
      return commands.updateCard({
        id: card.id,
        at: targetColumn,
        position: lastPosition + 1,
        ...(extras?.threadId !== undefined ? { threadId: extras.threadId } : {}),
        ...(extras?.prepStatus !== undefined ? { prepStatus: extras.prepStatus } : {}),
      });
    },
    [commands, grouped],
  );

  /**
   * Opening a card's thread moves the camera onto that thread's panel rather
   * than leaving for a route: the board is on the canvas, and so is the thread
   * it launched. Drafts have no panel yet, so they still get the draft route.
   */
  const openLinkedThread = useCallback(
    (card: KanbanCard) => {
      // Only this card's threadId — never fall through to "whatever is focused."
      const search = cardThreadStationSearch(card.threadId);
      if (!search) return false;
      const existing = findThreadRef(card.threadId as ThreadId);
      if (existing) {
        void navigate({
          to: "/kanban",
          search: { station: stationKey({ kind: "thread", entityId: existing.threadId }) },
        });
        return true;
      }
      const drafts = useComposerDraftStore.getState().draftThreadsByThreadKey;
      for (const [key, draft] of Object.entries(drafts)) {
        if (draft.threadId === card.threadId) {
          void navigate({
            to: "/draft/$draftId",
            params: { draftId: DraftId.make(key) },
          });
          return true;
        }
      }
      if (environmentId) {
        void navigate({
          to: "/kanban",
          search,
        });
        return true;
      }
      return false;
    },
    [environmentId, navigate],
  );

  /**
   * Skills model: board skills selection, else Hermes brain, else text-gen.
   * Usage checks must use this same instance — never a stale Claude error when
   * Hermes is cursor/grok.
   */
  const skillModelSelection = useCallback(() => {
    const boardSettings = readBoardSettings();
    const textGen =
      textGenerationModelSelection?.instanceId && textGenerationModelSelection.model
        ? {
            instanceId: String(textGenerationModelSelection.instanceId),
            model: textGenerationModelSelection.model,
          }
        : null;
    const selected = resolveBoardSkillModelSelection({
      hermesInstanceId: boardSettings.hermesInstanceId,
      hermesModel: boardSettings.hermesModel,
      hermesBrainInstanceId: boardSettings.hermesBrainInstanceId,
      hermesBrainModel: boardSettings.hermesBrainModel,
      textGeneration: textGen,
    });
    if (!selected) return undefined;
    return {
      instanceId: ProviderInstanceId.make(selected.instanceId),
      model: selected.model,
    };
  }, [textGenerationModelSelection]);

  /** Instance the skill pipeline / usage gate resolve to. */
  const resolveSkillInstanceId = useCallback((): string => {
    const boardSettings = readBoardSettings();
    return resolveBoardSkillInstanceId({
      hermesInstanceId: boardSettings.hermesInstanceId,
      hermesModel: boardSettings.hermesModel,
      hermesBrainInstanceId: boardSettings.hermesBrainInstanceId,
      hermesBrainModel: boardSettings.hermesBrainModel,
      textGenerationInstanceId: textGenerationModelSelection?.instanceId
        ? String(textGenerationModelSelection.instanceId)
        : null,
    });
  }, [textGenerationModelSelection]);

  const skillUsageBlockReason = useCallback((): string | null => {
    return providerUsageUnusableReason(usageSnapshot.data, resolveSkillInstanceId());
  }, [resolveSkillInstanceId, usageSnapshot.data]);

  const hermesActivityByCardId = useMemo(
    () => new Map((hermesBoard?.cardActivity ?? []).map((entry) => [entry.cardId, entry])),
    [hermesBoard?.cardActivity],
  );

  const hermesWatchByCardId = useMemo(
    () => new Map((hermesBoard?.cardWatch ?? []).map((entry) => [entry.cardId, entry])),
    [hermesBoard?.cardWatch],
  );

  const queueContext = useMemo(
    (): BoardQueueContext => ({
      brainEnabled: Boolean(hermesBoard?.enabled),
      ...automation,
      usageBlocked: skillUsageBlockReason() !== null,
      // The same two answers the header chip reads. A card must not promise a
      // tick the loop cannot take.
      loopBlocked:
        hermesBoard?.providerError ??
        (hermesBoard?.lastSkipIsBoxBlock === true ? hermesBoard.lastSkipReason : null),
      busy: hermesBoard?.busy === true,
      nextTickAtMs: hermesBoard?.nextTickAt ? Date.parse(hermesBoard.nextTickAt) : null,
      nextModelCheckAtMs: hermesBoard?.nextModelCheckAt
        ? Date.parse(hermesBoard.nextModelCheckAt)
        : null,
      nowMs,
      activityByCardId: hermesActivityByCardId,
      watchByCardId: hermesWatchByCardId,
    }),
    [
      automation,
      hermesBoard?.busy,
      hermesBoard?.enabled,
      hermesBoard?.lastSkipIsBoxBlock,
      hermesBoard?.lastSkipReason,
      hermesBoard?.providerError,
      hermesBoard?.nextTickAt,
      hermesBoard?.nextModelCheckAt,
      hermesActivityByCardId,
      hermesWatchByCardId,
      nowMs,
      skillUsageBlockReason,
    ],
  );

  const toastSkillUsageBlocked = useCallback((reason: string) => {
    const now = Date.now();
    if (now - usageBlockedToastAtRef.current < 60_000) return;
    usageBlockedToastAtRef.current = now;
    toastManager.add({
      type: "error",
      title: "Hermes skills paused",
      description: `${reason} Switch Hermes / text-generation to a usable provider, or wait for the reset.`,
    });
  }, []);

  const trackSkillJob = useCallback((cardId: string, active: boolean) => {
    if (active) {
      skillJobsRef.current.add(cardId);
    } else {
      skillJobsRef.current.delete(cardId);
    }
    setSkillJobCardIds([...skillJobsRef.current]);
  }, []);

  /**
   * Background Hermes skill run. Marks the card processing immediately, returns
   * control to the UI, finishes promote/update when the model is done.
   */
  const runSkillsInBackground = useCallback(
    (input: {
      card: KanbanCard;
      source: string;
      skills: ReadonlyArray<{ id: string; prompt: string }>;
      promote: boolean;
    }) => {
      const { card, source, skills, promote } = input;
      if (skillJobsRef.current.has(card.id)) {
        toastManager.add({
          type: "info",
          title: "Already running",
          description: "Hermes is already working on this card.",
        });
        return;
      }

      const usageBlock = skillUsageBlockReason();
      if (usageBlock) {
        autoSkillCardIdsRef.current.delete(card.id);
        toastSkillUsageBlocked(usageBlock);
        return;
      }

      const boardSettings = readBoardSettings();
      trackSkillJob(card.id, true);
      setIsRunningSkills(true);

      void (async () => {
        try {
          await commands.updateCard({
            id: card.id,
            at: "prompts",
            prepStatus: "processing",
          });
          refresh();

          const modelSelection = skillModelSelection();
          const { text, applied, steps } = await runSkillPipeline({
            source,
            skills,
            assist,
            ...(modelSelection ? { modelSelection } : {}),
          });

          if (applied === 0 && skills.length > 0) {
            throw new Error("No skills produced output.");
          }

          // Permanent audit trail: every skill input/output (survives card delete).
          if (steps.length > 0) {
            void commands.appendCardHistory({
              cardId: card.id,
              entries: steps.map((step) => ({
                kind: "skill" as const,
                skillId: step.skillId,
                inputText: step.input,
                outputText: step.output,
                ...(modelSelection ? { modelSelection } : {}),
              })),
            });
          }

          // Hermes owns semantic route selection. Browser skills may rewrite
          // text, but they never classify the task or pin a model.
          const routedModel = card.modelSelection;

          const title = promptTitle(text) || card.title;
          if (promote || boardSettings.autoPromoteDraftAfterSkills) {
            const columnCards = grouped.get("prompts") ?? [];
            const lastPosition = columnCards.reduce(
              (max, entry) => Math.max(max, entry.position),
              0,
            );
            const result = await commands.updateCard({
              id: card.id,
              title,
              body: text,
              at: "prompts",
              position: lastPosition + 1,
              prepStatus: prepStatusAfterSkillsPromote(),
              ...(routedModel ? { modelSelection: routedModel } : {}),
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            void commands.appendCardHistory({
              cardId: card.id,
              entries: [
                {
                  kind: "promote",
                  outputText: text,
                  meta: { toColumn: "prompts", applied },
                },
              ],
            });
            refresh();
            toastManager.add({
              type: "success",
              title: "Moved to Prompts",
              description: `Applied ${applied} skill${applied === 1 ? "" : "s"}.`,
            });
          } else {
            // Stay in Prompts as ready — untouched would re-trigger auto-skills on every refresh.
            const result = await commands.updateCard({
              id: card.id,
              title,
              body: text,
              at: "prompts",
              prepStatus: prepStatusAfterSkillsStayInDraft(),
              ...(routedModel ? { modelSelection: routedModel } : {}),
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            refresh();
            toastManager.add({
              type: "success",
              title: "Skills applied",
              description: `Applied ${applied} skill${applied === 1 ? "" : "s"} (Draft).`,
            });
          }
        } catch (runError: unknown) {
          const message =
            runError instanceof Error
              ? runError.message
              : typeof runError === "string"
                ? runError
                : "Could not apply skills (promptAssist failed — check Hermes model / provider).";
          void commands.appendCardHistory({
            cardId: card.id,
            entries: [{ kind: "error", errorText: message, inputText: source }],
          });
          void commands.updateCard({
            id: card.id,
            at: "prompts",
            prepStatus: prepStatusAfterSkillsFailure(),
          });
          refresh();
          toastManager.add({
            type: "error",
            title: "Hermes skill run failed",
            description: message,
          });
        } finally {
          trackSkillJob(card.id, false);
          if (skillJobsRef.current.size === 0) setIsRunningSkills(false);
        }
      })();
    },
    [
      assist,
      commands,
      grouped,
      refresh,
      skillModelSelection,
      skillUsageBlockReason,
      toastSkillUsageBlocked,
      trackSkillJob,
    ],
  );

  const runSkillsOnCard = useCallback(
    async (card: KanbanCard, currentText: string) => {
      const boardSettings = readBoardSettings();
      const source = currentText.trim() || cardPrompt(card);
      if (source.length === 0) {
        toastManager.add({
          type: "error",
          title: "Empty prompt",
          description: "Write something before running skills.",
        });
        return;
      }
      const skills = resolveBoardSkillPipeline({
        alwaysOnSkillIds: boardSettings.alwaysOnSkillIds,
        skillCommands,
      });

      if (skills.length === 0) {
        toastManager.add({
          type: "error",
          title: "No skills selected",
          description: "Add core skills (Defaults) in Global Skills if they are missing.",
        });
        return;
      }

      // Close editor immediately; Hermes works in the background.
      setSelectedCardId(null);
      toastManager.add({
        type: "info",
        title: "Applying skills",
        description: "Prompt transforms are running in the background.",
      });
      runSkillsInBackground({
        card,
        source,
        skills,
        promote: boardSettings.autoPromoteDraftAfterSkills,
      });
    },
    [runSkillsInBackground, skillCommands],
  );

  // Refresh kills in-browser skill jobs but leaves prepStatus=processing → a stuck "Applying skills".
  // Clear orphans immediately; only untouched drafts get auto-skills (ready = already processed).
  useEffect(() => {
    const boardSettings = readBoardSettings();
    // Live brain status wins; fall back to board/settings so a load race does not
    // open client auto-skills under an on-by-default Hermes brain.
    const brainEnabled =
      hermes?.enabled ?? hermesBoard?.enabled ?? boardSettings.hermesBrainEnabled;
    const autoApplySkills = clientAutoSkillsEnabled({
      brainEnabled,
      structureDrafts: boardRulePolicy(boardSettings).structureDrafts,
    });
    const usageBlock = skillUsageBlockReason();
    const skills = resolveBoardSkillPipeline({
      alwaysOnSkillIds: boardSettings.alwaysOnSkillIds,
      skillCommands,
    });
    const action = planBoardHermesClientPass({
      cards: cards.map(toBoardHermesCardSlice),
      liveSkillJobIds: skillJobsRef.current,
      sessionStartedIds: autoSkillCardIdsRef.current,
      // Brain on → Hermes owns structuring; client auto-skills stay off.
      autoApplySkills,
      usageBlocked: Boolean(usageBlock),
      hasSkillPipeline: skills.length > 0,
    });

    if (action.kind === "clear_orphaned_processing") {
      for (const id of action.cardIds) {
        void commands.updateCard({ id: KanbanCardId.make(id), prepStatus: "untouched" });
      }
      refresh();
      return;
    }

    if (action.kind === "noop") {
      return;
    }

    // Only toast when the client path would actually skill cards and the
    // resolved skill instance (not some other provider) is unusable.
    if (action.kind === "usage_blocked") {
      if (usageBlock) toastSkillUsageBlocked(usageBlock);
      return;
    }

    if (action.kind === "promote_untouched_without_skills") {
      for (const id of action.cardIds) {
        autoSkillCardIdsRef.current.add(id);
        void commands.updateCard({
          id: KanbanCardId.make(id),
          at: "prompts",
          prepStatus: "ready",
        });
      }
      refresh();
      return;
    }

    for (const id of action.cardIds) {
      const card = cards.find((entry) => entry.id === id);
      if (!card) continue;
      autoSkillCardIdsRef.current.add(id);
      runSkillsInBackground({
        card,
        source: cardPrompt(card),
        skills,
        promote: true,
      });
    }
  }, [
    cards,
    commands,
    hermes?.enabled,
    hermesBoard?.enabled,
    refresh,
    runSkillsInBackground,
    skillCommands,
    skillUsageBlockReason,
    toastSkillUsageBlocked,
  ]);

  const launchActiveThread = useCallback(
    async (card: KanbanCard) => {
      // The card's own project, always. The default project is a fallback only
      // when there is nothing to choose between — launching an unrouted card
      // into whichever project happens to sort first is how every task ends up
      // in the same repo.
      const carded = card.projectId != null ? projects.find((p) => p.id === card.projectId) : null;
      const projectRef = carded
        ? { environmentId: carded.environmentId, projectId: card.projectId as ProjectId }
        : projects.length === 1
          ? defaultProjectRef
          : null;
      if (projectRef === null) {
        toastManager.add({
          type: "error",
          title: "No project",
          description: card.projectId
            ? "Card project is missing from this environment."
            : "Pick a project for this card first — Hermes routes it, or set it yourself.",
        });
        return;
      }
      const launchThreads = threadsForLaunch(card.body, card.title);
      if (readBoardSettings().confirmBeforeLaunchActive) {
        const many = launchThreads.length > 1;
        const ok = await confirm({
          title: many ? `Start ${launchThreads.length} threads?` : "Start an Active coding thread?",
          description: many
            ? "The card's fenced t3-threads block spawns one thread each."
            : card.title,
          detail: many
            ? launchThreads.map((t) => `• ${t.title}${t.model ? ` (${t.model})` : ""}`).join("\n")
            : `${cardPrompt(card).slice(0, 400)}${cardPrompt(card).length > 400 ? "…" : ""}`,
          confirmLabel: many ? "Start them" : "Start it",
        });
        if (!ok) return;
      }
      setLaunchingActiveId(card.id);
      try {
        // Reuse existing primary thread link.
        if (card.threadId) {
          const result = await moveCard(card, "active", {
            threadId: card.threadId,
            prepStatus: "ready",
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          refresh();
          openLinkedThread({ ...card, at: "active" });
          return;
        }

        // Server-owned launch: creates the coding thread + first turn, links
        // the card, and moves it to Active — the board never navigates.
        const result = await commands.launchActive({
          id: card.id,
          projectId: projectRef.projectId,
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        refresh();
        toastManager.add({
          type: "success",
          title: "Active thread started",
          description: "Click the card anytime to open its conversation.",
        });
      } catch (launchError: unknown) {
        toastManager.add({
          type: "error",
          title: "Could not start active thread",
          description:
            launchError instanceof Error ? launchError.message : "Failed to launch conversation.",
        });
      } finally {
        setLaunchingActiveId(null);
      }
    },
    [commands, confirm, defaultProjectRef, moveCard, openLinkedThread, projects, refresh],
  );

  const openPromoteSkillsModal = useCallback((card: KanbanCard) => {
    setPromoteSkillsCard(card);
    setPromoteSkillIds(readAlwaysOnSkillIds());
  }, []);

  const applySkillsAndPromote = useCallback(
    (card: KanbanCard, skillIds: ReadonlyArray<string>, skipSkills: boolean) => {
      const text = cardPrompt(card);
      // Close modal immediately — never block the board on model latency.
      setPromoteSkillsCard(null);

      if (skipSkills || skillIds.length === 0) {
        void (async () => {
          try {
            const title = promptTitle(text) || card.title;
            const columnCards = grouped.get("prompts") ?? [];
            const lastPosition = columnCards.reduce(
              (max, entry) => Math.max(max, entry.position),
              0,
            );
            const result = await commands.updateCard({
              id: card.id,
              title,
              body: text,
              at: "prompts",
              position: lastPosition + 1,
              prepStatus: "ready",
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            refresh();
            toastManager.add({
              type: "success",
              title: "Moved to Prompts",
              description: "Ready queue.",
            });
          } catch (err: unknown) {
            toastManager.add({
              type: "error",
              title: "Could not move to Prompts",
              description: err instanceof Error ? err.message : "Move failed.",
            });
          }
        })();
        return;
      }

      const skills = resolveBoardSkillPipeline({
        alwaysOnSkillIds: skillIds,
        skillCommands,
      });

      toastManager.add({
        type: "info",
        title: "Applying skills",
        description: `Running ${skills.length} skill${skills.length === 1 ? "" : "s"}…`,
      });
      runSkillsInBackground({
        card,
        source: text,
        skills,
        promote: true,
      });
    },
    [commands, grouped, refresh, runSkillsInBackground, skillCommands],
  );

  const handleCreateDraft = useCallback(() => {
    if (environmentId === null) return;
    void commands
      .createCard({
        title: "New draft",
        body: "",
        at: "prompts",
        prepStatus: "untouched",
      })
      .then((result) => {
        if (result._tag === "Failure") {
          const failure = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Could not create draft",
            description: failure instanceof Error ? failure.message : "Create failed.",
          });
          return;
        }
        refresh();
        if (result._tag === "Success") {
          setSelectedCardId(result.value.id);
        }
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not create draft",
          description: error instanceof Error ? error.message : "Create failed.",
        });
      });
  }, [commands, defaultProjectRef, environmentId, refresh]);

  const archiveCard = useCallback(
    async (card: KanbanCard) => {
      const ok = await confirm({
        title: `Remove "${card.title}" from the board?`,
        description:
          "It leaves the board and Hermes stops seeing it. Restore it any time from Settings → Board.",
        confirmLabel: "Remove",
        destructive: true,
      });
      if (!ok) return;
      const result = await commands.updateCard({ id: card.id, archived: true });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Could not archive the card",
          description: String(squashAtomCommandFailure(result)),
        });
        return;
      }
      refresh();
      toastManager.add({
        type: "success",
        title: "Card archived",
        description: "Settings → Board restores it.",
      });
    },
    [commands, confirm, refresh],
  );

  /**
   * Move a card to a column, whatever asked for it.
   *
   * Dropping a card on a column is the desktop gesture; on a phone the board is
   * one column at a time and there is nowhere to drop it, so the card's own
   * dialog asks for the same move. Both land here — and what the move *does* is
   * the target column's `cardArrives` rule (`lib/boardRules.ts`), not a branch
   * per column name: launch, open PR, merge and redirect are all rule rows the
   * column's gear can rewire.
   */
  const requestColumn = useCallback(
    (card: KanbanCard, requestedColumn: ComponentId) => {
      const settings = readBoardSettings();
      if (requestedColumn.length === 0 || requestedColumn === card.at) return;
      const arrival = resolveArrival(settings, requestedColumn, card);
      const targetColumn = arrival.at;
      if (targetColumn !== requestedColumn && targetColumn === card.at) return;

      if (arrival.kind === "startThread") {
        // The same gate the store enforces, asked early so the refusal is a
        // toast on the card you dragged rather than a failed round trip. The
        // server still decides — this cannot let through anything the store
        // would refuse.
        const refusal = explainMoveBlock({ ...card, prepStatus: prepStatusOf(card) }, targetColumn);
        if (refusal !== null) {
          toastManager.add({ type: "error", title: "Cannot move there", description: refusal });
          return;
        }
        void launchActiveThread(card);
        return;
      }

      // Opening the pull request is the rule's doing. The coding agent in the
      // thread never touches git, so nothing exists on the forge until now.
      if (arrival.kind === "openPr") {
        void (async () => {
          if (!card.threadId) {
            toastManager.add({
              type: "error",
              title: "PR needs Active first",
              description: "Launch a coding thread before moving to PR.",
            });
            return;
          }
          const pending = toastManager.add({
            type: "info",
            title: "Opening pull request…",
            description: `Committing and pushing ${card.title}.`,
          });
          try {
            const result = await commands.openPr({ id: card.id });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            toastManager.add({
              type: "success",
              title: result.value.reusedExistingPr
                ? "Pushed to the open PR"
                : "Pull request opened",
              description: result.value.prUrl,
            });
            refresh();
          } catch (prError: unknown) {
            toastManager.add({
              type: "error",
              title: "Could not open the pull request",
              description: prError instanceof Error ? prError.message : "The forge refused it.",
            });
          } finally {
            toastManager.close(pending);
          }
        })();
        return;
      }

      // Merging is the rule's doing. A conflict, a red required check or a
      // missing approval leaves the card in PR with the forge's reason.
      //
      // A card that has no PR to merge used to fall through to a plain move, so
      // dropping anything on Done parked it there as shipped work — and shipped
      // work is what Hermes reads Done as, so the next prompt saying the same
      // thing was dropped as a duplicate. Clearing the board is archiving.
      if (arrival.kind === "mergePr" && card.at !== "pr") {
        toastManager.add({
          type: "error",
          title: "Done is merged work",
          description: "Take it through PR, or archive it to clear the board.",
        });
        return;
      }
      if (arrival.kind === "mergePr") {
        void (async () => {
          if (!card.prUrl) {
            toastManager.add({
              type: "error",
              title: "No pull request to merge",
              description: "Move the card to PR first.",
            });
            return;
          }
          const pending = toastManager.add({
            type: "info",
            title: "Merging pull request…",
            description: card.prUrl,
          });
          try {
            const result = await commands.mergePr({ id: card.id });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            toastManager.add({
              type: "success",
              title: "Merged",
              description: result.value.prUrl,
            });
            refresh();
          } catch (mergeError: unknown) {
            toastManager.add({
              type: "error",
              title: "Could not merge",
              description:
                mergeError instanceof Error ? mergeError.message : "The forge refused the merge.",
            });
          } finally {
            toastManager.close(pending);
          }
        })();
        return;
      }

      // Unready Prompt → ready: pick skills first.
      if (card.at === "prompts" && targetColumn === "prompts" && prepStatusOf(card) !== "ready") {
        if (!card.projectId) {
          toastManager.add({
            type: "error",
            title: "Assign a project first",
            description: "Every Prompts card must belong to a project.",
          });
          return;
        }
        openPromoteSkillsModal(card);
        return;
      }

      void commands
        .updateCard({
          id: card.id,
          at: targetColumn,
          position:
            (grouped.get(targetColumn) ?? []).reduce(
              (max, entry) => Math.max(max, entry.position),
              0,
            ) + 1,
          ...(targetColumn === "prompts" ? { prepStatus: "ready" as const } : {}),
        })
        .then((result) => {
          if (result._tag === "Failure") {
            const failure = squashAtomCommandFailure(result);
            toastManager.add({
              type: "error",
              title: "Could not move card",
              description: failure instanceof Error ? failure.message : "Move failed.",
            });
            return;
          }
          refresh();
        })
        .catch((moveError: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not move card",
            description: moveError instanceof Error ? moveError.message : "Move failed.",
          });
        });
    },
    [commands, grouped, launchActiveThread, openPromoteSkillsModal, refresh],
  );

  /**
   * File the card that stands for a pull request dragged off a review list.
   *
   * The board's own object for "a pull request somebody is working" is a card,
   * so a dropped row becomes one — the PR fields filled in from the row, the
   * card's project taken from the repo it is on.
   */
  const cardForPr = useCallback(
    async (pr: PrRef): Promise<KanbanCard | null> => {
      const created = await commands.createCard({
        title: `#${pr.number} ${pr.title}`.trim(),
        body: pr.url,
        at: "prompts",
        prepStatus: "ready",
        ...(pr.projectId.length === 0 ? {} : { projectId: pr.projectId as ProjectId }),
      });
      if (created._tag !== "Success") {
        toastManager.add({
          type: "error",
          title: "Could not file the pull request",
          description: String(squashAtomCommandFailure(created)),
        });
        return null;
      }
      const linked = await commands.updateCard({
        id: created.value.id,
        prUrl: pr.url,
        prTitle: pr.title,
        prNumber: pr.number,
        baseBranch: pr.baseRefName,
      });
      refresh();
      return linked._tag === "Success" ? linked.value : created.value;
    },
    [commands, refresh],
  );

  /**
   * A pull request dropped on a column: file its card, then let the column's own
   * `cardArrives` rule take it, exactly as if a card had been dragged there.
   */
  const handlePrColumnDrop = useCallback(
    async (pr: PrRef, column: ComponentId) => {
      if (column.length === 0) return;
      const card = await cardForPr(pr);
      if (card !== null) requestColumn(card, column);
    },
    [cardForPr, requestColumn],
  );

  /**
   * File the card that stands for an issue dragged off an issue list. Same
   * shape as `cardForPr`: title carries the number, body carries the URL, so
   * the launched thread knows exactly which issue it is working.
   */
  const cardForIssue = useCallback(
    async (issue: IssueRef, prep: "ready" | "untouched"): Promise<KanbanCard | null> => {
      const created = await commands.createCard({
        title: `#${issue.number} ${issue.title}`.trim(),
        body: issue.url,
        at: "prompts",
        prepStatus: prep,
        ...(issue.projectId.length === 0 ? {} : { projectId: issue.projectId as ProjectId }),
      });
      if (created._tag !== "Success") {
        toastManager.add({
          type: "error",
          title: "Could not file the issue",
          description: String(squashAtomCommandFailure(created)),
        });
        return null;
      }
      refresh();
      return created.value;
    },
    [commands, refresh],
  );

  /**
   * An issue dropped on a column: file its card, then let the column's own
   * `cardArrives` rule take it, exactly as if a card had been dragged there.
   *
   * An issue is a claim, not an instruction — dropped on Prompts it lands
   * untouched so the structuring pass investigates it before anything launches.
   * Dropping it straight on Active is the explicit override: file it ready and
   * launch.
   */
  const handleIssueColumnDrop = useCallback(
    async (issue: IssueRef, column: ComponentId) => {
      if (column.length === 0) return;
      const card = await cardForIssue(issue, column === "prompts" ? "untouched" : "ready");
      if (card !== null && column !== "prompts") requestColumn(card, column);
    },
    [cardForIssue, requestColumn],
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const pr = prRefFromDrag(event.active.data.current);
      const issue = pr !== null ? null : issueRefFromDrag(event.active.data.current);
      setDragPr(pr);
      setDragIssue(issue);
      setDragCard(
        pr !== null || issue !== null
          ? null
          : (cards.find((entry) => entry.id === String(event.active.id)) ?? null),
      );
    },
    [cards],
  );

  const handleDragCancel = useCallback(() => {
    setDragCard(null);
    setDragPr(null);
    setDragIssue(null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDragCard(null);
      setDragPr(null);
      setDragIssue(null);
      const { active, over } = event;

      // A pull request row is a `pr-ref` payload, not a card: it lands on a
      // column and the column's arrival rule takes it.
      const dropOver =
        over === null
          ? null
          : {
              id: String(over.id),
              ...(typeof over.data.current?.at === "string"
                ? { column: over.data.current.at }
                : {}),
            };
      const prDrop = resolvePrRefDrop({ active: active.data.current, over: dropOver });
      if (prDrop !== null) {
        void handlePrColumnDrop(prDrop.pr, prDrop.column as ComponentId);
        return;
      }

      // An issue row is an `issue-ref` payload: same target as a PR row.
      const issueDrop = resolveIssueRefDrop({ active: active.data.current, over: dropOver });
      if (issueDrop !== null) {
        void handleIssueColumnDrop(issueDrop.issue, issueDrop.column as ComponentId);
        return;
      }

      if (!over) return;
      const card = cards.find((entry) => entry.id === String(active.id));
      if (!card) return;

      if (over.data.current?.archive === true || over.id === ARCHIVE_DROP_ID) {
        void archiveCard(card);
        return;
      }
      requestColumn(card, (over.data.current?.at ?? over.id) as ComponentId);
    },
    [archiveCard, cards, handleIssueColumnDrop, handlePrColumnDrop, requestColumn],
  );

  const handleSave = useCallback(
    async (
      card: KanbanCard,
      nextPrompt: string,
      fields: {
        projectId: ProjectId | null;
        modelSelection: { instanceId: ProviderInstanceId; model: string } | null;
        baseBranch: string | null;
      },
    ) => {
      const trimmed = nextPrompt.trim();
      if (trimmed.length === 0) return;
      const title = promptTitle(trimmed);
      if (title.length === 0) return;
      setIsSaving(true);
      try {
        // A changed model is a human pin. Editing text without touching the
        // picker preserves Hermes provenance instead of silently converting it
        // into a sticky human choice.
        const projectChanged = (card.projectId ?? null) !== fields.projectId;
        const modelChanged =
          `${card.modelSelection?.instanceId ?? ""}::${card.modelSelection?.model ?? ""}` !==
          (fields.modelSelection
            ? `${fields.modelSelection.instanceId}::${fields.modelSelection.model}`
            : "::");
        const modelSelection =
          !modelChanged && fields.modelSelection !== null && card.modelSelection !== null
            ? card.modelSelection
            : fields.modelSelection;
        const now = new Date().toISOString();
        const result = await commands.updateCard({
          id: card.id,
          title,
          body: trimmed,
          projectId: fields.projectId,
          projectRouteProvenance: projectChanged
            ? fields.projectId
              ? { source: "human", skill: null, at: now }
              : null
            : card.projectRouteProvenance,
          modelSelection,
          modelRouteReason: modelChanged ? null : card.modelRouteReason,
          modelRouteProvenance: modelChanged
            ? fields.modelSelection
              ? { source: "human", skill: null, at: now }
              : null
            : card.modelRouteProvenance,
          modelRouteUsage: modelChanged ? null : card.modelRouteUsage,
          baseBranch: fields.baseBranch,
          ...(card.at === "prompts" &&
          prepStatusOf(card) !== "processing" &&
          prepStatusOf(card) !== "ready"
            ? { prepStatus: "untouched" as const }
            : {}),
        });
        if (result._tag === "Failure") {
          const failure = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Could not save prompt",
            description: failure instanceof Error ? failure.message : "Save failed.",
          });
          return;
        }
        refresh();
        setSelectedCardId(null);
      } catch (saveError: unknown) {
        toastManager.add({
          type: "error",
          title: "Could not save prompt",
          description: saveError instanceof Error ? saveError.message : "Save failed.",
        });
      } finally {
        setIsSaving(false);
      }
    },
    [commands, refresh],
  );

  const handleOpenCard = useCallback((card: KanbanCard) => {
    // A card opens as itself at every column. Jumping straight into the thread
    // from Active / PR / Done put the card's own record — prompt, stage clock,
    // tokens — behind the one stage where it was worth reading; the record's
    // own "Open conversation" is the way through to the thread.
    setSelectedCardId(card.id);
  }, []);

  const contextValue = useMemo(
    (): BoardContextValue => ({
      environmentId,
      error,
      isPending,
      grouped,
      columns,
      openCard: handleOpenCard,
      createDraft: handleCreateDraft,
      openColumnRules: setRulesColumn,
      projectTitleById,
      modelLabelFor,
      hermesWorkingIds,
      queueContext,
      prChecksById,
      nowMs,
    }),
    [
      environmentId,
      error,
      isPending,
      grouped,
      columns,
      handleOpenCard,
      handleCreateDraft,
      projectTitleById,
      modelLabelFor,
      hermesWorkingIds,
      queueContext,
      prChecksById,
      nowMs,
    ],
  );

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {/* The whole tree, not only the panels: the card record reads the board's
          columns for its "Move to" row, and rendering it outside this provider
          left that row with nothing in it but Archive — so a card could only be
          started by dragging it, which is the one thing a phone cannot do. */}
      <BoardContext.Provider value={contextValue}>
        {children}

        {/* The ghost travels in screen space, above every panel at every zoom. */}
        <DragOverlay dropAnimation={null} zIndex={600}>
          {dragPr ? (
            <div className="w-64 rounded-xl border border-border bg-card p-3 text-xs font-medium text-foreground shadow-2xl shadow-black/40">
              #{dragPr.number} {dragPr.title}
            </div>
          ) : dragIssue ? (
            <div className="w-64 rounded-xl border border-border bg-card p-3 text-xs font-medium text-foreground shadow-2xl shadow-black/40">
              #{dragIssue.number} {dragIssue.title}
            </div>
          ) : dragCard ? (
            <div className="w-64 rounded-xl border border-border bg-card p-3 text-xs font-medium text-foreground shadow-2xl shadow-black/40">
              {cardDisplay(dragCard)}
            </div>
          ) : null}
        </DragOverlay>

        {/* Somewhere to drop a card that should leave the board, wherever its
            column panel happens to be parked. Only exists mid-drag. */}
        {dragCard ? (
          <div
            className={cn(
              "pointer-events-none fixed inset-x-0 z-[500] flex justify-center",
              BOTTOM_ABOVE_CAPTURE_BAR,
            )}
          >
            <ArchiveDropZone />
          </div>
        ) : null}

        {skillJobCardIds.length > 0 ? (
          <div
            className={cn(
              "pointer-events-none fixed inset-x-0 z-[450] flex justify-center",
              BOTTOM_ABOVE_DROP_ZONE,
            )}
          >
            <div className="flex items-center gap-2 rounded-full border border-amber-500/40 bg-card/95 px-3 py-1.5 text-xs text-amber-800 shadow-md dark:text-amber-200">
              <Loader2Icon className="size-3.5 animate-spin" />
              Applying skills · {skillJobCardIds.length} card
              {skillJobCardIds.length === 1 ? "" : "s"}
            </div>
          </div>
        ) : null}

        {launchingActiveId ? (
          <div
            className={cn(
              "pointer-events-none fixed inset-x-0 z-[450] flex justify-center",
              BOTTOM_ABOVE_DROP_ZONE,
            )}
          >
            <div className="flex items-center gap-2 rounded-full border border-border bg-card/95 px-3 py-1.5 text-xs text-muted-foreground shadow-md">
              <Loader2Icon className="size-3.5 animate-spin" />
              Starting conversation…
            </div>
          </div>
        ) : null}

        <CardDetailDialog
          card={selectedCard}
          open={selectedCard !== null}
          onOpenChange={(open) => {
            if (!open) setSelectedCardId(null);
          }}
          onSave={handleSave}
          onMoveColumn={requestColumn}
          onArchive={(card) => void archiveCard(card)}
          onOpenThread={(card) => {
            setSelectedCardId(null);
            openLinkedThread(card);
          }}
          onRunSkills={runSkillsOnCard}
          projects={projects}
          environmentId={environmentId}
          onOpenHistory={() => setHistoryOpen(true)}
          onPromoteToPrompts={async (card, currentText) => {
            const text = currentText.trim() || cardPrompt(card);
            if (text.length === 0) return;
            // Persist edits first, then skills modal.
            if (text !== cardPrompt(card).trim()) {
              const title = promptTitle(text);
              const save = await commands.updateCard({
                id: card.id,
                title: title || card.title,
                body: text,
                projectId: card.projectId,
                ...(card.modelSelection ? { modelSelection: card.modelSelection } : {}),
              });
              if (save._tag === "Failure") {
                const failure = squashAtomCommandFailure(save);
                toastManager.add({
                  type: "error",
                  title: "Could not save before promote",
                  description: failure instanceof Error ? failure.message : "Save failed.",
                });
                return;
              }
              refresh();
            }
            setSelectedCardId(null);
            openPromoteSkillsModal({ ...card, body: text, title: promptTitle(text) || card.title });
          }}
          isSaving={isSaving}
          isRunningSkills={selectedCard != null && skillJobCardIds.includes(selectedCard.id)}
          skills={globalSkills}
          alwaysOnIds={alwaysOnIds}
          onToggleAlwaysOn={(id, enabled) => {
            setAlwaysOnIds(toggleAlwaysOnSkillId(id, enabled));
          }}
        />

        <CardHistoryDialog
          card={selectedCard}
          open={historyOpen && selectedCard !== null}
          onOpenChange={setHistoryOpen}
          listHistory={async (cardId) => {
            const result = await commands.listCardHistory({ cardId });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            return result.value.entries;
          }}
        />

        <Dialog
          open={promoteSkillsCard !== null}
          onOpenChange={(open) => {
            if (!open) setPromoteSkillsCard(null);
          }}
        >
          <DialogPopup className="max-w-md">
            <DialogHeader className="gap-1 p-4 pb-2 sm:p-5 sm:pb-2">
              <DialogTitle className="text-base">Apply skills before Prompts?</DialogTitle>
            </DialogHeader>
            <DialogPanel className="space-y-3 px-4 py-2 sm:px-5">
              <p className="text-xs text-muted-foreground">
                Pick skills, then Apply — Hermes runs them in the background (you stay on the
                board). Reorder with ↑↓. Always-on skills are pre-selected.
              </p>
              {globalSkills.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No global skills yet. Add them in Settings → Board, or skip.
                </p>
              ) : (
                <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-md border border-border/60 p-2">
                  {(() => {
                    const selected = promoteSkillIds
                      .map((id) => globalSkills.find((s) => s.id === id))
                      .filter((s): s is (typeof globalSkills)[number] => Boolean(s));
                    const selectedSet = new Set(promoteSkillIds);
                    const rest = globalSkills.filter((s) => !selectedSet.has(s.id));
                    const rows = [
                      ...selected.map((s) => ({ skill: s, on: true as const })),
                      ...rest.map((s) => ({ skill: s, on: false as const })),
                    ];
                    return rows.map(({ skill, on }) => {
                      const idx = promoteSkillIds.indexOf(skill.id);
                      return (
                        <div
                          key={skill.id}
                          className="flex items-start gap-1.5 rounded-md px-2 py-1.5 hover:bg-muted/50"
                        >
                          {on ? (
                            <div className="flex shrink-0 flex-col gap-0.5 pt-0.5">
                              <button
                                type="button"
                                className="rounded px-1 text-[10px] text-muted-foreground hover:bg-muted disabled:opacity-30"
                                disabled={idx <= 0}
                                aria-label={`Move ${skill.id} up`}
                                onClick={() => {
                                  if (idx <= 0) return;
                                  setPromoteSkillIds((prev) => {
                                    const next = [...prev];
                                    const t = next[idx - 1]!;
                                    next[idx - 1] = next[idx]!;
                                    next[idx] = t;
                                    return next;
                                  });
                                }}
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                className="rounded px-1 text-[10px] text-muted-foreground hover:bg-muted disabled:opacity-30"
                                disabled={idx < 0 || idx >= promoteSkillIds.length - 1}
                                aria-label={`Move ${skill.id} down`}
                                onClick={() => {
                                  if (idx < 0 || idx >= promoteSkillIds.length - 1) return;
                                  setPromoteSkillIds((prev) => {
                                    const next = [...prev];
                                    const t = next[idx + 1]!;
                                    next[idx + 1] = next[idx]!;
                                    next[idx] = t;
                                    return next;
                                  });
                                }}
                              >
                                ↓
                              </button>
                            </div>
                          ) : (
                            <span className="w-5 shrink-0" />
                          )}
                          <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2">
                            <input
                              type="checkbox"
                              className="mt-0.5"
                              checked={on}
                              onChange={(e) => {
                                setPromoteSkillIds((prev) =>
                                  e.target.checked
                                    ? [...prev, skill.id]
                                    : prev.filter((id) => id !== skill.id),
                                );
                              }}
                            />
                            <span className="min-w-0">
                              <span className="block text-[12px] font-medium">
                                {on ? `${idx + 1}. ` : ""}
                                {skill.id}
                              </span>
                              <span className="line-clamp-2 text-[10px] text-muted-foreground">
                                {skill.prompt.slice(0, 120)}
                                {skill.prompt.length > 120 ? "…" : ""}
                              </span>
                            </span>
                          </label>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </DialogPanel>
            <DialogFooter
              variant="bare"
              className="flex-row items-center justify-between gap-2 border-t border-border/60 px-4 py-2.5 sm:px-5"
            >
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={!promoteSkillsCard}
                onClick={() => {
                  if (!promoteSkillsCard) return;
                  applySkillsAndPromote(promoteSkillsCard, [], true);
                }}
              >
                Skip skills
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!promoteSkillsCard}
                onClick={() => {
                  if (!promoteSkillsCard) return;
                  applySkillsAndPromote(promoteSkillsCard, promoteSkillIds, false);
                }}
              >
                {promoteSkillIds.length > 0 ? "Apply in background" : "Move to Prompts"}
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
        <ColumnRulesDialog
          column={rulesColumn}
          onOpenChange={(open) => {
            if (!open) setRulesColumn(null);
          }}
          onRename={renameColumn}
        />

        {confirmDialog}
      </BoardContext.Provider>
    </DndContext>
  );
}

/**
 * One kanban column, as the body of its own canvas panel.
 *
 * Requires a {@link KanbanBoardProvider} above the panel layer — without one
 * the column can only say so, which is what the dev gallery renders.
 */
export function BoardColumn({
  column,
  compact = false,
}: {
  readonly column: ComponentId;
  readonly compact?: boolean;
}) {
  const board = useBoardContext();
  if (board === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-xs text-muted-foreground">
        No board context.
      </div>
    );
  }
  const cards = board.grouped.get(column) ?? [];
  // The cards outrank every notice: a column whose header counts cards and
  // whose body shows a sentence instead is a card you cannot get at.
  if (board.environmentId === null && cards.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Connect an environment to use the board.
      </div>
    );
  }
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {board.error ? (
        <div className="mx-2 mt-2 rounded-md bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          Board failed to load — retrying.
        </div>
      ) : null}
      {board.environmentId === null ? (
        <div className="mx-2 mt-2 rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">
          No environment — connect one to move these.
        </div>
      ) : null}
      {board.isPending && cards.length === 0 ? (
        <div className="flex flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" /> Loading…
        </div>
      ) : (
        <Column
          column={column}
          compact={compact}
          fill
          cards={cards}
          onOpen={board.openCard}
          projectTitleById={board.projectTitleById}
          modelLabelFor={board.modelLabelFor}
          hermesWorkingIds={board.hermesWorkingIds}
          queueContext={board.queueContext}
          prChecksById={board.prChecksById}
          nowMs={board.nowMs}
          onOpenSettings={() => board.openColumnRules(column)}
          {...(column === "prompts" ? { onAddDraft: board.createDraft } : {})}
        />
      )}
    </div>
  );
}

/**
 * The legacy monolithic board: all four columns in a row. Only rendered by a
 * `board` panel surviving from an older canvas snapshot, until the reconciler
 * replaces it with the column panels. Same provider, same data.
 */
export function KanbanBoard() {
  const columns = useBoardContext()?.columns ?? [];
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex h-full min-h-full gap-3 p-4 pb-36">
        {columns.map((column) => (
          <BoardColumn key={column.id} column={column.id} />
        ))}
      </div>
    </ScrollArea>
  );
}
