/**
 * Open pull requests, for one project or for a named set of repos.
 *
 * One implementation, two callers: `liveBoardApi.listOpenPrs` (what Hermes asks
 * per project) and the `kanban.listOpenPrs` RPC behind the review panel,
 * which asks for the repos the panel is bound to. A second forge-reading path
 * would drift on the one thing that matters here — what counts as open.
 *
 * Nothing degrades quietly. A repo the caller named that no project on the board
 * answers to, and a checkout whose forge will not resolve, both fail: the review
 * panel showing four PRs instead of nine is indistinguishable from nine being
 * the true answer.
 *
 * @module kanban/hermes/openPrList
 */
import type { RepositoryIdentity, SourceControlProviderError } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import {
  unavailableChangeRequestChecks,
  type ChangeRequestChecks,
} from "../../sourceControl/SourceControlProvider.ts";
import type { BoardOpenPr, BoardProject } from "./boardApi.ts";

/** `owner/repo` for the router and the prompt, from whichever field has it. */
export function repoSlugOf(identity: RepositoryIdentity | null): string | null {
  if (!identity) return null;
  if (identity.owner && identity.name) return `${identity.owner}/${identity.name}`;
  return identity.locator.remoteUrl;
}

/** The board's projects, as the shell snapshot holds them. */
export function boardProjectsOf(
  projects: ReadonlyArray<{
    readonly id: unknown;
    readonly title: string;
    readonly workspaceRoot: string | null;
    readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
  }>,
): ReadonlyArray<BoardProject> {
  return projects.map((project) => ({
    id: String(project.id),
    name: project.title,
    workspaceRoot: project.workspaceRoot,
    repo: repoSlugOf(project.repositoryIdentity ?? null),
  }));
}

/** An open pull request plus where it came from — the panel spans repos. */
export type OpenPrRow = BoardOpenPr & {
  readonly projectId: string;
  /** The project's `owner/name`, or its remote URL when that is all there is. */
  readonly repo: string;
  readonly checks: ChangeRequestChecks;
  readonly checkedAt: DateTime.Utc;
  /** Last forge activity on the pull request, when the forge reported one. */
  readonly updatedAt: DateTime.Utc | null;
};

export const OPEN_PR_DEFAULT_LIMIT = 20;
export const OPEN_PR_MAX_LIMIT = 50;

export interface OpenPrQuery {
  /** One project by id. Mutually exclusive with `repos`. */
  readonly projectId?: string;
  /**
   * Repos to read, as `owner/name` or the bare name. Empty (or absent) is every
   * repo the board has a project for.
   */
  readonly repos?: ReadonlyArray<string>;
  /** Pull requests per repo. Default 20, max 50. */
  readonly limit?: number;
}

/** What a repo may be named as: its slug, and the name after the owner. */
export function repoAliases(repo: string): ReadonlyArray<string> {
  const slug = repo.trim().toLowerCase();
  const name = slug.slice(slug.lastIndexOf("/") + 1);
  return name.length > 0 && name !== slug ? [slug, name] : [slug];
}

/** A repo the caller named that no project on the board is checked out from. */
export class UnknownRepoError extends Data.TaggedError("UnknownRepoError")<{
  readonly repo: string;
  readonly known: ReadonlyArray<string>;
}> {
  override get message(): string {
    return (
      `No project on this board is checked out from ${this.repo}. ` +
      (this.known.length === 0
        ? "The board has no project with a repo."
        : `The board has: ${this.known.join(", ")}.`)
    );
  }
}

/**
 * Which projects a query reads. Pure, so the repo vocabulary is testable without
 * a forge: a query naming repos resolves every one of them or fails.
 */
export function selectPrProjects(
  projects: ReadonlyArray<BoardProject>,
  query: Pick<OpenPrQuery, "projectId" | "repos">,
): ReadonlyArray<BoardProject> {
  if (query.projectId !== undefined) {
    return projects.filter((project) => project.id === query.projectId);
  }
  const withRepo = projects.filter((project) => (project.repo ?? "").trim().length > 0);
  const wanted = (query.repos ?? []).map((repo) => repo.trim()).filter((repo) => repo.length > 0);
  if (wanted.length === 0) return withRepo;

  const byAlias = new Map<string, Array<BoardProject>>();
  for (const project of withRepo) {
    for (const alias of repoAliases(project.repo ?? "")) {
      const bucket = byAlias.get(alias) ?? [];
      bucket.push(project);
      byAlias.set(alias, bucket);
    }
  }
  const picked = new Map<string, BoardProject>();
  for (const repo of wanted) {
    const matches = byAlias.get(repo.toLowerCase());
    if (matches === undefined) {
      throw new UnknownRepoError({
        repo,
        known: withRepo.map((project) => project.repo ?? ""),
      });
    }
    for (const project of matches) picked.set(project.id, project);
  }
  return [...picked.values()];
}

export function openPrLimit(limit: number | undefined): number {
  return Math.min(Math.max(1, limit ?? OPEN_PR_DEFAULT_LIMIT), OPEN_PR_MAX_LIMIT);
}

export interface OpenPrDeps<E = never> {
  readonly projects: Effect.Effect<ReadonlyArray<BoardProject>, E>;
  readonly sourceControl: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"];
}

/** Every open pull request the query asks for, newest repo order preserved. */
export function listOpenPrs<E>(
  deps: OpenPrDeps<E>,
  query: OpenPrQuery,
): Effect.Effect<ReadonlyArray<OpenPrRow>, E | UnknownRepoError | SourceControlProviderError> {
  const limit = openPrLimit(query.limit);
  return Effect.gen(function* () {
    const projects = yield* deps.projects;
    // The only throw in `selectPrProjects` is the repo nothing answers to.
    const selected = yield* Effect.try({
      try: () => selectPrProjects(projects, query),
      catch: (cause) => cause as UnknownRepoError,
    });
    const rows: Array<OpenPrRow> = [];
    for (const project of selected) {
      const cwd = project.workspaceRoot;
      // A project with no checkout has nothing to ask, and the interface says so:
      // empty when it has no forge. A checkout that does exist and will not
      // resolve is a different answer, and it fails below.
      if (cwd === null || cwd.length === 0) continue;
      const provider = yield* deps.sourceControl.resolve({ cwd });
      // An empty head selector is "every open pull request": the forge clients
      // drop the head filter rather than match a branch literally named "".
      const requests = yield* provider.listChangeRequests({
        cwd,
        headSelector: "",
        state: "open",
        limit,
      });
      for (const request of requests) {
        if (request.state !== "open") continue;
        const checks = provider.getChangeRequestChecks
          ? yield* provider
              .getChangeRequestChecks({ cwd, reference: request.url })
              .pipe(
                Effect.catch((cause) =>
                  Effect.succeed(
                    unavailableChangeRequestChecks(
                      cause instanceof Error
                        ? cause.message
                        : "The forge did not answer the CI check request.",
                    ),
                  ),
                ),
              )
          : unavailableChangeRequestChecks(
              `The ${provider.kind} source-control provider cannot fetch CI checks.`,
            );
        rows.push({
          number: request.number,
          title: request.title,
          url: request.url,
          headRefName: request.headRefName,
          baseRefName: request.baseRefName,
          state: request.state,
          projectId: project.id,
          repo: project.repo ?? cwd,
          checks,
          checkedAt: yield* DateTime.now,
          updatedAt: Option.getOrNull(request.updatedAt),
        });
      }
    }
    return rows;
  });
}
