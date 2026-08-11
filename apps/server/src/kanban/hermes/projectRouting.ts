/**
 * How a card names a project, and how that name resolves back to an id.
 *
 * A raw UUID is the one thing a model cannot check itself against: it is not in
 * the card, not in the repo, and a real-but-wrong one launches silently. So the
 * board speaks a human slug — the repo name or the checkout's basename — and
 * resolves whatever a program wrote back to an id here, refusing what it cannot
 * place.
 *
 * @module kanban/hermes/projectRouting
 */
import type { BoardProject } from "./boardApi.ts";

const basename = (path: string): string =>
  path
    .replace(/[/\\]+$/, "")
    .split(/[/\\]/)
    .pop() ?? "";

const sanitize = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");

const repoName = (repo: string | null): string => {
  if (!repo) return "";
  const tail = repo.split("/").pop() ?? "";
  return tail.replace(/\.git$/, "");
};

/** The stable human name for one project: repo name, else checkout basename. */
export function projectSlug(project: BoardProject): string {
  const candidates = [
    repoName(project.repo),
    project.workspaceRoot ? basename(project.workspaceRoot) : "",
    project.name,
  ];
  for (const candidate of candidates) {
    const slug = sanitize(candidate);
    if (slug.length > 0) return slug;
  }
  return sanitize(project.id) || "project";
}

/**
 * A slug per project id, disambiguated. Two checkouts of one repo would answer
 * to the same word otherwise, which is the failure this whole module is about.
 */
export function projectSlugs(projects: ReadonlyArray<BoardProject>): ReadonlyMap<string, string> {
  const grouped = new Map<string, BoardProject[]>();
  for (const project of projects) {
    const base = projectSlug(project);
    grouped.set(base, [...(grouped.get(base) ?? []), project]);
  }
  const slugs = new Map<string, string>();
  for (const [base, group] of grouped) {
    for (const [index, project] of group.toSorted((left, right) => left.id.localeCompare(right.id)).entries()) {
      slugs.set(project.id, index === 0 ? base : `${base}-${index + 1}`);
    }
  }
  return slugs;
}

const workspaceSegments = (root: string | null): ReadonlyArray<string> | null => {
  if (!root) return null;
  const normalized = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.length === 0 ? null : normalized.split("/");
};

const isAncestor = (outer: ReadonlyArray<string>, inner: ReadonlyArray<string>): boolean =>
  outer.length < inner.length && outer.every((segment, index) => segment === inner[index]);

/**
 * Drop hits whose checkout merely *contains* another hit's checkout.
 *
 * A project rooted at `/root/projects` holds `/root/projects/vps-code`, so a
 * file search answers in both and routing reads as permanently ambiguous. The
 * deeper checkout is the specific answer. Roots compare on path segments, so
 * `/root/projects` never contains `/root/projects-other`; equal roots and a
 * missing root are never nested either way.
 */
export function dropNestedWorkspaceAncestors<T extends { readonly projectId: string }>(
  hits: ReadonlyArray<T>,
  projects: ReadonlyArray<BoardProject>,
): ReadonlyArray<T> {
  const rootOf = new Map(
    projects.map((project) => [project.id, workspaceSegments(project.workspaceRoot)] as const),
  );
  const roots = hits.map((hit) => rootOf.get(hit.projectId) ?? null);
  return hits.filter((_, index) => {
    const own = roots[index];
    if (!own) return true;
    return !roots.some((other, at) => at !== index && other != null && isAncestor(own, other));
  });
}

/** Every string that may stand for this project in a card or a program. */
function aliasesOf(project: BoardProject, slug: string): ReadonlyArray<string> {
  return [
    project.id,
    slug,
    project.name,
    project.repo ?? "",
    repoName(project.repo),
    project.workspaceRoot ?? "",
    project.workspaceRoot ? basename(project.workspaceRoot) : "",
  ].filter((alias) => alias.trim().length > 0);
}

/**
 * The project id a written value means, or null when nothing on the board
 * matches it. Ids match exactly; every other alias matches case-insensitively.
 */
export function resolveProjectId(
  projects: ReadonlyArray<BoardProject>,
  value: string,
): string | null {
  const wanted = value.trim();
  if (wanted.length === 0) return null;
  const direct = projects.find((project) => project.id === wanted);
  if (direct) return direct.id;
  const slugs = projectSlugs(projects);
  const lowered = wanted.toLowerCase();
  const slugMatches = projects.filter(
    (project) => (slugs.get(project.id) ?? projectSlug(project)).toLowerCase() === lowered,
  );
  if (slugMatches.length === 1) return slugMatches[0]!.id;
  if (slugMatches.length > 1) return null;
  const matches = projects.filter((project) =>
    aliasesOf(project, slugs.get(project.id) ?? projectSlug(project)).some(
      (alias) => alias.toLowerCase() === lowered,
    ),
  );
  return matches.length === 1 ? matches[0]!.id : null;
}

/** What a refused write says, so the next program does not repeat the guess. */
export function unknownProjectMessage(
  projects: ReadonlyArray<BoardProject>,
  value: string,
): string {
  const slugs = projectSlugs(projects);
  const known = projects.map((project) => slugs.get(project.id) ?? projectSlug(project)).join(", ");
  return (
    `no project '${value}' on this board — use a slug or id from PROJECTS` +
    (known.length > 0 ? ` (${known})` : "")
  );
}
