import { useDraggable } from "@dnd-kit/core";
import { CircleDotIcon } from "lucide-react";
import { useMemo } from "react";

import { cn } from "~/lib/utils";
import { useOpenIssues } from "~/state/kanban";
import { issueRefDragData, issueRefDragId, type IssueRef } from "../refDrops";
import { parseRepoBinding, repoBindingLabel } from "./PrReviewPanel.logic";

/**
 * The issue list: open issues on the repos this panel is bound to.
 *
 * Same shape as the PR review list: the binding is the panel's own address —
 * `issues` is every repo the board has a project for, `issues:owner/name` is
 * one — and every row is a drag payload (`issue-ref`) on the board's dnd-kit
 * context. Drop one on a column and the column's arrival rule takes the card it
 * files.
 *
 * @module components/canvas/panels/IssueListPanel
 */

/** The list's own presentation, from props — the dev gallery renders this one. */
export function IssueListView({
  repos,
  issues,
  error,
  loading,
  showRepo,
}: {
  readonly repos: ReadonlyArray<string>;
  readonly issues: ReadonlyArray<IssueRef>;
  /** Why there is no list. Never rendered as an empty list. */
  readonly error: string | null;
  readonly loading: boolean;
  /** Repo badge per row — on when the list spans more than one. */
  readonly showRepo: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="issue-list-panel">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <CircleDotIcon className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {/* A bound list is named by its repos in the title bar above; saying
              it again here is the same line twice. */}
          {repos.length === 0 ? repoBindingLabel(repos) : null}
        </span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
          {issues.length}
        </span>
      </div>

      {error !== null ? (
        <p className="p-3 text-xs text-rose-600 dark:text-rose-400">{error}</p>
      ) : loading ? (
        <p className="p-3 text-xs text-muted-foreground">Reading the forge…</p>
      ) : issues.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">No open issues.</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {issues.map((issue) => (
            <IssueRow key={`${issue.repo}#${issue.number}`} issue={issue} showRepo={showRepo} />
          ))}
        </ul>
      )}
    </div>
  );
}

function IssueRow({ issue, showRepo }: { readonly issue: IssueRef; readonly showRepo: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: issueRefDragId(issue),
    data: issueRefDragData(issue),
  });
  return (
    <li>
      <div
        ref={setNodeRef}
        {...listeners}
        {...attributes}
        className={cn(
          "mb-1.5 cursor-grab rounded-lg border border-border bg-card p-2.5 text-xs shadow-sm",
          isDragging && "opacity-40",
        )}
      >
        <div className="flex items-baseline gap-1.5">
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            #{issue.number}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">{issue.title}</span>
        </div>
        {showRepo || issue.labels.length > 0 ? (
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
            {showRepo ? <span className="truncate">{issue.repo}</span> : null}
            {issue.labels.map((label) => (
              <span key={label} className="rounded-full bg-muted px-1.5 py-0.5">
                {label}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function IssueListPanel({ entityId }: { readonly entityId: string }) {
  const repos = useMemo(() => parseRepoBinding(entityId), [entityId]);
  const { issues, error, isPending } = useOpenIssues(repos);
  const rows = useMemo(
    (): ReadonlyArray<IssueRef> =>
      issues.map((issue) => ({
        repo: issue.repo,
        projectId: issue.projectId,
        number: issue.number,
        title: issue.title,
        url: issue.url,
        labels: issue.labels,
      })),
    [issues],
  );
  return (
    <IssueListView
      repos={repos}
      issues={rows}
      // A forge that would not answer is not an empty repo: the panel says so
      // rather than showing "no open issues".
      error={error === null || error === undefined ? null : String(error)}
      loading={isPending}
      showRepo={repos.length !== 1}
    />
  );
}
