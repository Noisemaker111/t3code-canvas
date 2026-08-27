import { useDraggable } from "@dnd-kit/core";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CopyIcon,
  ExternalLinkIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  ListFilterIcon,
  RefreshCwIcon,
  SquareKanbanIcon,
  XIcon,
} from "lucide-react";
import * as DateTime from "effect/DateTime";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { usePrimaryEnvironment } from "~/state/environments";
import { useKanbanCommands, useOpenPrs } from "~/state/kanban";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { toastManager } from "~/components/ui/toast";
import { useConfirm } from "~/components/ui/useConfirm";
import { PrChecksBadge } from "../../kanban/CardTileView";
import { describePrChecks, formatTimeInColumn } from "../../kanban/KanbanBoard.logic";
import { useBoardContext } from "../../kanban/KanbanBoard";
import { prRefDragData, prRefDragId } from "../refDrops";
import {
  activePrFilterCount,
  cardIdForPr,
  DEFAULT_PR_FILTER,
  filterPrRows,
  parseRepoBinding,
  PR_CARD_LABEL,
  PR_CI_LABEL,
  PR_SORT_LABEL,
  prCardIndex,
  prRowRepos,
  repoBindingLabel,
  type PrCardFilter,
  type PrCiFilter,
  type PrListFilter,
  type PrReviewRow,
  type PrSortKey,
} from "./PrReviewPanel.logic";

/**
 * The review list: open pull requests on the repos this panel is bound to.
 *
 * The binding is the panel's own address — `prs` is every repo the board has a
 * project for, `prs:owner/name,other/name` is those two — and it is the *query*:
 * what the forge is asked for. Narrowing what came back is the toolbar's job, so
 * looking at one repo, or at the red ones, costs a click rather than a panel.
 *
 * Rows are drag payloads (`pr-ref`), on the board's dnd-kit context: drop one on
 * a column and the column's own arrival rule takes it. They are also actionable
 * in place — open on the forge, copy the link, open the card the board filed for
 * it, merge it.
 *
 * @module components/canvas/panels/PrReviewPanel
 */

/** What a row can do besides being dragged. Absent ones are not rendered. */
export interface PrRowActions {
  readonly onOpenCard?: ((row: PrReviewRow) => void) | undefined;
  readonly onMerge?: ((row: PrReviewRow) => void) | undefined;
  /** The row a merge is running for — its button spins and the rest stay live. */
  readonly mergingCardId?: string | null | undefined;
}

/** The list's own presentation, from props — the dev gallery renders this one. */
export function PrReviewListView({
  repos,
  prs,
  error,
  loading,
  showRepo,
  filter = DEFAULT_PR_FILTER,
  onFilterChange,
  onRefresh,
  actions,
}: {
  readonly repos: ReadonlyArray<string>;
  readonly prs: ReadonlyArray<PrReviewRow>;
  /** Why there is no list. Never rendered as an empty list. */
  readonly error: string | null;
  readonly loading: boolean;
  /** Repo badge per row — on when the list spans more than one. */
  readonly showRepo: boolean;
  readonly filter?: PrListFilter;
  readonly onFilterChange?: ((next: PrListFilter) => void) | undefined;
  readonly onRefresh?: (() => void) | undefined;
  readonly actions?: PrRowActions | undefined;
}) {
  const repoOptions = useMemo(() => prRowRepos(prs), [prs]);
  const shown = useMemo(() => filterPrRows(prs, filter), [prs, filter]);
  const narrowed = activePrFilterCount(filter);
  const set = (patch: Partial<PrListFilter>) => onFilterChange?.({ ...filter, ...patch });

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="pr-review-panel">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <GitPullRequestIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {/* A bound list is named by its repos in the title bar above; saying
              it again here is the same line twice. */}
          {repos.length === 0 ? repoBindingLabel(repos) : null}
        </span>
        <span
          className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground"
          data-testid="pr-review-count"
        >
          {narrowed === 0 ? shown.length : `${shown.length}/${prs.length}`}
        </span>
        {onRefresh === undefined ? null : (
          <button
            type="button"
            aria-label="Refresh pull requests"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onRefresh}
          >
            <RefreshCwIcon className="size-3.5" />
          </button>
        )}
      </div>

      {onFilterChange === undefined ? null : (
        <PrFilterBar
          filter={filter}
          repoOptions={repoOptions}
          narrowed={narrowed}
          onChange={set}
          onClear={() => onFilterChange(DEFAULT_PR_FILTER)}
        />
      )}

      {error !== null ? (
        <p className="p-3 text-xs text-rose-600 dark:text-rose-400">{error}</p>
      ) : loading ? (
        <p className="p-3 text-xs text-muted-foreground">Reading the forge…</p>
      ) : prs.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">No open pull requests.</p>
      ) : shown.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">No pull request matches the filter.</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {shown.map((pr) => (
            <PrRow
              key={`${pr.repo}#${pr.number}`}
              pr={pr}
              showRepo={showRepo}
              actions={actions ?? {}}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

const CI_OPTIONS: ReadonlyArray<PrCiFilter> = ["any", "passing", "failing", "pending", "unknown"];
const CARD_OPTIONS: ReadonlyArray<PrCardFilter> = ["any", "carded", "orphan"];
const SORT_OPTIONS: ReadonlyArray<PrSortKey> = ["recent", "oldest", "repo", "ci"];

function PrFilterBar({
  filter,
  repoOptions,
  narrowed,
  onChange,
  onClear,
}: {
  readonly filter: PrListFilter;
  readonly repoOptions: ReadonlyArray<string>;
  readonly narrowed: number;
  readonly onChange: (patch: Partial<PrListFilter>) => void;
  readonly onClear: () => void;
}) {
  const toggleRepo = (repo: string) =>
    onChange({
      repos: filter.repos.includes(repo)
        ? filter.repos.filter((entry) => entry !== repo)
        : [...filter.repos, repo],
    });

  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5">
      <input
        type="search"
        value={filter.text}
        placeholder="Filter"
        aria-label="Filter pull requests"
        data-testid="pr-review-search"
        className="h-6.5 min-w-0 flex-1 rounded border border-border bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground/72 focus:border-ring"
        onChange={(event) => onChange({ text: event.target.value })}
      />
      <Popover>
        <PopoverTrigger
          className={cn(
            "inline-flex h-6.5 shrink-0 items-center gap-1 rounded border border-border px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground",
            narrowed > 0 && "border-ring text-foreground",
          )}
          aria-label="Pull request filters"
          data-testid="pr-review-filters"
        >
          <ListFilterIcon className="size-3.5" />
          {narrowed > 0 ? <span className="tabular-nums">{narrowed}</span> : null}
        </PopoverTrigger>
        <PopoverPopup align="end" className="w-60" data-testid="pr-review-filter-menu">
          <div className="flex flex-col gap-3">
            <FilterSection label="Repos">
              {repoOptions.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">Nothing loaded yet.</p>
              ) : (
                repoOptions.map((repo) => (
                  <FilterChip
                    key={repo}
                    label={repo}
                    active={filter.repos.includes(repo)}
                    onClick={() => toggleRepo(repo)}
                  />
                ))
              )}
            </FilterSection>
            <FilterSection label="CI">
              {CI_OPTIONS.map((state) => (
                <FilterChip
                  key={state}
                  label={PR_CI_LABEL[state]}
                  active={filter.ci === state}
                  onClick={() => onChange({ ci: state })}
                />
              ))}
            </FilterSection>
            <FilterSection label="Board">
              {CARD_OPTIONS.map((state) => (
                <FilterChip
                  key={state}
                  label={PR_CARD_LABEL[state]}
                  active={filter.card === state}
                  onClick={() => onChange({ card: state })}
                />
              ))}
            </FilterSection>
            <FilterSection label="Sort">
              {SORT_OPTIONS.map((sort) => (
                <FilterChip
                  key={sort}
                  label={PR_SORT_LABEL[sort]}
                  active={filter.sort === sort}
                  onClick={() => onChange({ sort })}
                />
              ))}
            </FilterSection>
          </div>
        </PopoverPopup>
      </Popover>
      {narrowed === 0 ? null : (
        <button
          type="button"
          aria-label="Clear pull request filters"
          data-testid="pr-review-clear-filters"
          className="inline-flex size-6.5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onClear}
        >
          <XIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function FilterSection({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "rounded-full border px-2 py-0.5 text-[11px]",
        active
          ? "border-ring bg-accent text-foreground"
          : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function PrRow({
  pr,
  showRepo,
  actions,
}: {
  readonly pr: PrReviewRow;
  readonly showRepo: boolean;
  readonly actions: PrRowActions;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: prRefDragId(pr),
    data: prRefDragData(pr),
  });
  const { copyToClipboard } = useCopyToClipboard({ target: "pull request link" });
  const ciBadge = describePrChecks(pr.checks);
  const merging = actions.mergingCardId !== null && actions.mergingCardId === pr.cardId;
  return (
    <li>
      <div
        ref={setNodeRef}
        className={cn(
          "group mb-1.5 rounded-lg border border-border bg-card p-2.5 text-xs shadow-sm",
          isDragging && "opacity-40",
        )}
        data-testid={`pr-review-row-${pr.number}`}
      >
        {/* The drag handle is the row's text: the action buttons beside it stay
            clickable rather than starting a drag off their own press. */}
        <div className="cursor-grab" {...listeners} {...attributes}>
          <div className="flex items-baseline gap-1.5">
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              #{pr.number}
            </span>
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">{pr.title}</span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            {showRepo ? <span className="truncate">{pr.repo}</span> : null}
            <span className="truncate font-mono">
              {pr.headRefName} → {pr.baseRefName}
            </span>
            {pr.updatedAt === null ? null : (
              <span className="ms-auto shrink-0 tabular-nums">
                {formatTimeInColumn(Date.now() - DateTime.toEpochMillis(pr.updatedAt))}
              </span>
            )}
          </div>
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          {ciBadge === null ? null : (
            <PrChecksBadge badge={ciBadge} url={pr.checks.failingUrl ?? pr.url} />
          )}
          <div className="ms-auto flex shrink-0 items-center gap-0.5">
            {actions.onOpenCard === undefined || pr.cardId === null ? null : (
              <RowAction
                label="Open the card"
                onClick={() => actions.onOpenCard?.(pr)}
                testId={`pr-review-card-${pr.number}`}
              >
                <SquareKanbanIcon className="size-3.5" />
              </RowAction>
            )}
            {actions.onMerge === undefined || pr.cardId === null ? null : (
              <RowAction
                label={merging ? "Merging…" : "Merge"}
                disabled={merging}
                onClick={() => actions.onMerge?.(pr)}
                testId={`pr-review-merge-${pr.number}`}
              >
                <GitMergeIcon className={cn("size-3.5", merging && "animate-pulse")} />
              </RowAction>
            )}
            <RowAction
              label="Copy the link"
              onClick={() => copyToClipboard(pr.url, undefined)}
              testId={`pr-review-copy-${pr.number}`}
            >
              <CopyIcon className="size-3.5" />
            </RowAction>
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              title="Open on the forge"
              aria-label="Open on the forge"
              data-testid={`pr-review-open-${pr.number}`}
              className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ExternalLinkIcon className="size-3.5" />
            </a>
          </div>
        </div>
      </div>
    </li>
  );
}

function RowAction({
  label,
  onClick,
  disabled = false,
  testId,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function PrReviewPanel({ entityId }: { readonly entityId: string }) {
  const repos = useMemo(() => parseRepoBinding(entityId), [entityId]);
  const { prs, error, isPending, refresh } = useOpenPrs(repos);
  const [filter, setFilter] = useState<PrListFilter>(DEFAULT_PR_FILTER);
  const [mergingCardId, setMergingCardId] = useState<string | null>(null);
  const board = useBoardContext();
  const environment = usePrimaryEnvironment();
  const commands = useKanbanCommands(environment?.environmentId ?? null);
  const { confirm, confirmDialog } = useConfirm();

  const cards = useMemo(() => (board === null ? [] : [...board.grouped.values()].flat()), [board]);
  const cardById = useMemo(() => new Map(cards.map((card) => [card.id as string, card])), [cards]);
  const rows = useMemo((): ReadonlyArray<PrReviewRow> => {
    const index = prCardIndex(cards);
    return prs.map((pr) => ({
      repo: pr.repo,
      projectId: pr.projectId,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      checks: pr.checks,
      updatedAt: pr.updatedAt,
      cardId: cardIdForPr(index, pr),
    }));
  }, [cards, prs]);

  useEffect(() => {
    const timer = window.setInterval(refresh, 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const openCard = (row: PrReviewRow) => {
    const card = row.cardId === null ? undefined : cardById.get(row.cardId);
    if (card === undefined || board === null) return;
    board.openCard(card);
  };

  // The board's own merge, from the list the pull requests are already in.
  // Same command the PR column's arrival rule runs, so a red required check or a
  // conflict fails here exactly as it fails there.
  const mergeRow = (row: PrReviewRow) => {
    const card = row.cardId === null ? undefined : cardById.get(row.cardId);
    if (card === undefined) return;
    void (async () => {
      const confirmed = await confirm({
        title: `Merge #${row.number}?`,
        description: row.title,
        detail: `${row.repo} · ${row.headRefName} → ${row.baseRefName}`,
        confirmLabel: "Merge",
      });
      if (!confirmed) return;
      setMergingCardId(card.id);
      try {
        const result = await commands.mergePr({ id: card.id });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        toastManager.add({ type: "success", title: "Merged", description: row.url });
        refresh();
      } catch (mergeError: unknown) {
        toastManager.add({
          type: "error",
          title: "Could not merge",
          description: mergeError instanceof Error ? mergeError.message : "The forge refused it.",
        });
      } finally {
        setMergingCardId(null);
      }
    })();
  };

  return (
    <>
      <PrReviewListView
        repos={repos}
        prs={rows}
        // A forge that would not answer is not an empty board: the panel says so
        // rather than showing "no open pull requests".
        error={error === null || error === undefined ? null : String(error)}
        loading={isPending}
        showRepo={repos.length !== 1}
        filter={filter}
        onFilterChange={setFilter}
        onRefresh={refresh}
        actions={{
          onOpenCard: board === null ? undefined : openCard,
          onMerge: board === null ? undefined : mergeRow,
          mergingCardId,
        }}
      />
      {confirmDialog}
    </>
  );
}
