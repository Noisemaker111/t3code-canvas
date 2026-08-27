/**
 * Pull request and issue rows dragged out of a panel, and where they land.
 *
 * A row inside a panel is DOM, so it travels on the board's own dnd-kit context
 * — the same one the card tiles use, which is why a pull request can be dropped
 * on a column at all. Everything here is the pure half: what the payload is, and
 * which column a drop landed on.
 *
 * @module components/canvas/refDrops
 */

export const PR_REF_DRAG_KIND = "pr-ref";

/** A pull request, as a row hands it to whatever it is dropped on. */
export interface PrRef {
  /** `owner/name` of the repo the pull request is on. */
  readonly repo: string;
  /** The board project that repo is checked out as. */
  readonly projectId: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly headRefName: string;
  readonly baseRefName: string;
}

export function prRefDragId(pr: PrRef): string {
  return `${PR_REF_DRAG_KIND}:${pr.repo}#${pr.number}`;
}

export function prRefDragData(pr: PrRef): { readonly kind: string; readonly pr: PrRef } {
  return { kind: PR_REF_DRAG_KIND, pr };
}

/** The pull request a drag is carrying, or null when it is carrying a card. */
export function prRefFromDrag(data: unknown): PrRef | null {
  if (data === null || typeof data !== "object") return null;
  const bag = data as { kind?: unknown; pr?: unknown };
  if (bag.kind !== PR_REF_DRAG_KIND) return null;
  const pr = bag.pr as Partial<PrRef> | undefined;
  if (typeof pr?.number !== "number" || typeof pr.repo !== "string") return null;
  return {
    repo: pr.repo,
    projectId: typeof pr.projectId === "string" ? pr.projectId : "",
    number: pr.number,
    title: typeof pr.title === "string" ? pr.title : "",
    url: typeof pr.url === "string" ? pr.url : "",
    headRefName: typeof pr.headRefName === "string" ? pr.headRefName : "",
    baseRefName: typeof pr.baseRefName === "string" ? pr.baseRefName : "",
  };
}

/** The other draggable row: an issue out of an issue list panel. */
export const ISSUE_REF_DRAG_KIND = "issue-ref";

/** An issue, as a row hands it to whatever it is dropped on. */
export interface IssueRef {
  /** `owner/name` of the repo the issue is on. */
  readonly repo: string;
  /** The board project that repo is checked out as. */
  readonly projectId: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly labels: ReadonlyArray<string>;
}

export function issueRefDragId(issue: IssueRef): string {
  return `${ISSUE_REF_DRAG_KIND}:${issue.repo}#${issue.number}`;
}

export function issueRefDragData(issue: IssueRef): {
  readonly kind: string;
  readonly issue: IssueRef;
} {
  return { kind: ISSUE_REF_DRAG_KIND, issue };
}

/** The issue a drag is carrying, or null when it is carrying something else. */
export function issueRefFromDrag(data: unknown): IssueRef | null {
  if (data === null || typeof data !== "object") return null;
  const bag = data as { kind?: unknown; issue?: unknown };
  if (bag.kind !== ISSUE_REF_DRAG_KIND) return null;
  const issue = bag.issue as Partial<IssueRef> | undefined;
  if (typeof issue?.number !== "number" || typeof issue.repo !== "string") return null;
  return {
    repo: issue.repo,
    projectId: typeof issue.projectId === "string" ? issue.projectId : "",
    number: issue.number,
    title: typeof issue.title === "string" ? issue.title : "",
    url: typeof issue.url === "string" ? issue.url : "",
    labels: Array.isArray(issue.labels)
      ? issue.labels.filter((label): label is string => typeof label === "string")
      : [],
  };
}

/** Which column a dragged row was dropped on, or null for a drop on nothing. */
function refDropColumn(
  over: { readonly id: string; readonly column?: string } | null,
): string | null {
  const column = over === null ? null : (over.column ?? over.id);
  return column !== null && column.length > 0 ? column : null;
}

/** Where a pull request was dropped. */
export function resolvePrRefDrop(input: {
  readonly active: unknown;
  readonly over: { readonly id: string; readonly column?: string } | null;
}): { readonly pr: PrRef; readonly column: string } | null {
  const pr = prRefFromDrag(input.active);
  if (pr === null) return null;
  const column = refDropColumn(input.over);
  return column === null ? null : { pr, column };
}

/** Where an issue was dropped. Same target resolution as a pull request row. */
export function resolveIssueRefDrop(input: {
  readonly active: unknown;
  readonly over: { readonly id: string; readonly column?: string } | null;
}): { readonly issue: IssueRef; readonly column: string } | null {
  const issue = issueRefFromDrag(input.active);
  if (issue === null) return null;
  const column = refDropColumn(input.over);
  return column === null ? null : { issue, column };
}
