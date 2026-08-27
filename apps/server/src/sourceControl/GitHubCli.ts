import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  TrimmedNonEmptyString,
  type SourceControlRepositoryVisibility,
  type VcsError,
} from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import { decodeGitHubIssueListJson, type NormalizedGitHubIssueRecord } from "./gitHubIssues.ts";
import {
  decodeGitHubPullRequestJson,
  decodeGitHubPullRequestListJson,
} from "./gitHubPullRequests.ts";
import { ghPrArgs, isAlreadyMergedGhOutput, isMergedPrState } from "./ghPullRequestArgs.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

const gitHubCliFailureFields = {
  command: Schema.Literal("gh"),
  cwd: Schema.String,
  cause: Schema.Defect(),
} as const;

export class GitHubCliUnavailableError extends Schema.TaggedErrorClass<GitHubCliUnavailableError>()(
  "GitHubCliUnavailableError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "GitHub CLI (`gh`) is required but not available on PATH.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubCliAuthenticationError extends Schema.TaggedErrorClass<GitHubCliAuthenticationError>()(
  "GitHubCliAuthenticationError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "GitHub CLI is not authenticated. Run `gh auth login` and retry.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubPullRequestNotFoundError extends Schema.TaggedErrorClass<GitHubPullRequestNotFoundError>()(
  "GitHubPullRequestNotFoundError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "Pull request not found. Check the PR number or URL and try again.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubCliCommandError extends Schema.TaggedErrorClass<GitHubCliCommandError>()(
  "GitHubCliCommandError",
  {
    ...gitHubCliFailureFields,
    /**
     * Bounded tail of what `gh` printed, when the call site captured it. A bare
     * "GitHub CLI command failed." parks a kanban card with no way to tell an
     * unmergeable PR from a dead network — the reason is the diagnosis.
     */
    reason: Schema.optional(Schema.String),
  },
) {
  get detail(): string {
    return this.reason !== undefined && this.reason.length > 0
      ? `GitHub CLI command failed: ${this.reason}`
      : "GitHub CLI command failed.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

const gitHubCliDecodeFields = {
  command: Schema.Literal("gh"),
  cwd: Schema.String,
  cause: Schema.Defect(),
} as const;

export class GitHubPullRequestListDecodeError extends Schema.TaggedErrorClass<GitHubPullRequestListDecodeError>()(
  "GitHubPullRequestListDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid PR list JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in listOpenPullRequests: ${this.detail}`;
  }
}

export class GitHubChangeRequestListDecodeError extends Schema.TaggedErrorClass<GitHubChangeRequestListDecodeError>()(
  "GitHubChangeRequestListDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid change request JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in listChangeRequests: ${this.detail}`;
  }
}

export class GitHubIssueListDecodeError extends Schema.TaggedErrorClass<GitHubIssueListDecodeError>()(
  "GitHubIssueListDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid issue list JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in listOpenIssues: ${this.detail}`;
  }
}

export class GitHubPullRequestDecodeError extends Schema.TaggedErrorClass<GitHubPullRequestDecodeError>()(
  "GitHubPullRequestDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid pull request JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in getPullRequest: ${this.detail}`;
  }
}

export class GitHubRepositoryDecodeError extends Schema.TaggedErrorClass<GitHubRepositoryDecodeError>()(
  "GitHubRepositoryDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid repository JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in getRepositoryCloneUrls: ${this.detail}`;
  }
}

export const GitHubCliError = Schema.Union([
  GitHubCliUnavailableError,
  GitHubCliAuthenticationError,
  GitHubPullRequestNotFoundError,
  GitHubCliCommandError,
  GitHubPullRequestListDecodeError,
  GitHubChangeRequestListDecodeError,
  GitHubIssueListDecodeError,
  GitHubPullRequestDecodeError,
  GitHubRepositoryDecodeError,
]);
export type GitHubCliError = typeof GitHubCliError.Type;

export const isGitHubCliError = Schema.is(GitHubCliError);

export function fromVcsError(
  context: {
    readonly command: "gh";
    readonly cwd: string;
  },
  error: VcsError,
): GitHubCliError {
  if (
    error._tag === "VcsProcessSpawnError" &&
    error.cause instanceof PlatformError.PlatformError &&
    error.cause.reason._tag === "NotFound" &&
    error.cause.reason.module === "ChildProcess" &&
    error.cause.reason.method === "spawn"
  ) {
    return new GitHubCliUnavailableError({ ...context, cause: error });
  }

  if (error._tag === "VcsProcessExitError") {
    if (error.failureKind === "authentication") {
      return new GitHubCliAuthenticationError({ ...context, cause: error });
    }
    if (error.failureKind === "not-found") {
      return new GitHubPullRequestNotFoundError({ ...context, cause: error });
    }
  }

  return new GitHubCliCommandError({ ...context, cause: error });
}

export interface GitHubPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state?: "open" | "closed" | "merged";
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

export interface GitHubRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export class GitHubCli extends Context.Service<
  GitHubCli,
  {
    readonly execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly timeoutMs?: number;
    }) => Effect.Effect<VcsProcess.VcsProcessOutput, GitHubCliError>;

    readonly listOpenPullRequests: (input: {
      readonly cwd: string;
      readonly headSelector: string;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<GitHubPullRequestSummary>, GitHubCliError>;

    readonly listOpenIssues: (input: {
      readonly cwd: string;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<NormalizedGitHubIssueRecord>, GitHubCliError>;

    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
    }) => Effect.Effect<GitHubPullRequestSummary, GitHubCliError>;

    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly repository: string;
    }) => Effect.Effect<GitHubRepositoryCloneUrls, GitHubCliError>;
    readonly listRepositories?: (input: {
      readonly cwd: string;
    }) => Effect.Effect<ReadonlyArray<GitHubRepositoryCloneUrls>, GitHubCliError>;

    readonly createRepository: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly visibility: SourceControlRepositoryVisibility;
    }) => Effect.Effect<GitHubRepositoryCloneUrls, GitHubCliError>;

    readonly createPullRequest: (input: {
      readonly cwd: string;
      readonly baseBranch: string;
      readonly headSelector: string;
      readonly title: string;
      readonly bodyFile: string;
    }) => Effect.Effect<void, GitHubCliError>;

    readonly mergePullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
    }) => Effect.Effect<string | null, GitHubCliError>;

    readonly closePullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
    }) => Effect.Effect<void, GitHubCliError>;

    readonly getDefaultBranch: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string | null, GitHubCliError>;

    readonly checkoutPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly force?: boolean;
    }) => Effect.Effect<void, GitHubCliError>;

    /** Raw `statusCheckRollup` JSON for a pull request. */
    readonly getPullRequestChecks: (input: {
      readonly cwd: string;
      readonly reference: string;
    }) => Effect.Effect<string, GitHubCliError>;
  }
>()("t3/sourceControl/GitHubCli") {}

const RawGitHubRepositoryCloneUrlsSchema = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});
const decodeRawGitHubRepositoryCloneUrls = Schema.decodeEffect(
  Schema.fromJsonString(RawGitHubRepositoryCloneUrlsSchema),
);

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawGitHubRepositoryCloneUrlsSchema>,
): GitHubRepositoryCloneUrls {
  return {
    nameWithOwner: raw.nameWithOwner,
    url: raw.url,
    sshUrl: raw.sshUrl,
  };
}

/**
 * `gh repo create` prints the canonical URL of the new repository on stdout
 * (e.g. `https://github.com/owner/repo`). Reading it back here avoids a
 * follow-up `gh repo view`, which can race GitHub's GraphQL eventual
 * consistency window and falsely report the just-created repo as missing.
 */
function deriveRepositoryCloneUrlsFromCreateOutput(
  stdout: string,
  repository: string,
): GitHubRepositoryCloneUrls {
  const fallbackHost = "github.com";
  const match = stdout.match(/https?:\/\/[^\s]+/);
  if (match) {
    const cleaned = match[0].replace(/\.git$/, "");
    try {
      const parsed = new URL(cleaned);
      const pathname = parsed.pathname.replace(/^\/+|\/+$/g, "");
      const segments = pathname.split("/").filter(Boolean);
      if (segments.length === 2) {
        const nameWithOwner = `${segments[0]}/${segments[1]}`;
        return {
          nameWithOwner,
          url: `${parsed.origin}/${nameWithOwner}`,
          sshUrl: `git@${parsed.host}:${nameWithOwner}.git`,
        };
      }
    } catch {
      // Fall through to the input-derived defaults below.
    }
  }
  return {
    nameWithOwner: repository,
    url: `https://${fallbackHost}/${repository}`,
    sshUrl: `git@${fallbackHost}:${repository}.git`,
  };
}

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;

  const execute: GitHubCli["Service"]["execute"] = (input) =>
    process
      .run({
        operation: "GitHubCli.execute",
        command: "gh",
        args: input.args,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
      .pipe(Effect.mapError((error) => fromVcsError({ command: "gh", cwd: input.cwd }, error)));

  return GitHubCli.of({
    execute,
    listOpenPullRequests: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "list",
          "--head",
          input.headSelector,
          "--state",
          "open",
          "--limit",
          String(input.limit ?? 1),
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => decodeGitHubPullRequestListJson(raw)).pipe(
                Effect.flatMap((decoded) => {
                  if (!Result.isSuccess(decoded)) {
                    return Effect.fail(
                      new GitHubPullRequestListDecodeError({
                        command: "gh",
                        cwd: input.cwd,
                        cause: decoded.failure,
                      }),
                    );
                  }

                  return Effect.succeed(
                    decoded.success.map(({ updatedAt: _updatedAt, ...summary }) => summary),
                  );
                }),
              ),
        ),
      ),
    listOpenIssues: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "issue",
          "list",
          "--state",
          "open",
          "--limit",
          String(input.limit ?? 20),
          "--json",
          "number,title,url,state,labels",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => decodeGitHubIssueListJson(raw)).pipe(
                Effect.flatMap((decoded) =>
                  Result.isSuccess(decoded)
                    ? Effect.succeed(decoded.success)
                    : Effect.fail(
                        new GitHubIssueListDecodeError({
                          command: "gh",
                          cwd: input.cwd,
                          cause: decoded.failure,
                        }),
                      ),
                ),
              ),
        ),
      ),
    getPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "view",
          input.reference,
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.sync(() => decodeGitHubPullRequestJson(raw)).pipe(
            Effect.flatMap((decoded) => {
              if (!Result.isSuccess(decoded)) {
                return Effect.fail(
                  new GitHubPullRequestDecodeError({
                    command: "gh",
                    cwd: input.cwd,
                    cause: decoded.failure,
                  }),
                );
              }

              return Effect.succeed(
                (({ updatedAt: _updatedAt, ...summary }) => summary)(decoded.success),
              );
            }),
          ),
        ),
      ),
    getRepositoryCloneUrls: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", input.repository, "--json", "nameWithOwner,url,sshUrl"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeRawGitHubRepositoryCloneUrls(raw).pipe(
            Effect.mapError(
              (cause) =>
                new GitHubRepositoryDecodeError({
                  command: "gh",
                  cwd: input.cwd,
                  cause,
                }),
            ),
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    listRepositories: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "list", "--limit", "100", "--json", "nameWithOwner,url,sshUrl"],
      }).pipe(
        Effect.map(
          (result) => JSON.parse(result.stdout) as ReadonlyArray<GitHubRepositoryCloneUrls>,
        ),
        Effect.catch((cause) =>
          Effect.fail(new GitHubRepositoryDecodeError({ command: "gh", cwd: input.cwd, cause })),
        ),
        Effect.map((items) => items.map(normalizeRepositoryCloneUrls)),
      ),
    createRepository: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "create", input.repository, `--${input.visibility}`],
      }).pipe(
        Effect.map((result) =>
          deriveRepositoryCloneUrlsFromCreateOutput(result.stdout, input.repository),
        ),
      ),
    createPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "create",
          "--base",
          input.baseBranch,
          "--head",
          input.headSelector,
          "--title",
          input.title,
          "--body-file",
          input.bodyFile,
        ],
      }).pipe(Effect.asVoid),
    // `gh pr merge` exits non-zero on a dirty merge, a failing required check
    // or a missing approval, and `execute` turns that into a GitHubCliError
    // carrying stderr. That error text is what the board shows, so a conflicted
    // merge surfaces as a real failure rather than a silent column move.
    // Run with `allowNonZeroExit` and classify here: the transport error
    // redacts stderr, and a merge refused because the PR is not mergeable must
    // carry gh's own reason — the pipeline's sync-and-retry dance keys on it.
    //
    // Args use --repo when the reference is a full URL so a detached-HEAD
    // project checkout does not break `gh` (it must not need `git branch`).
    // Already-merged is success: Hermes was looping forever treating it as fail.
    mergePullRequest: (input) =>
      process
        .run({
          operation: "GitHubCli.mergePullRequest.precheck",
          command: "gh",
          args: ghPrArgs("view", input.reference, ["--json", "state,mergeCommit"]),
          cwd: input.cwd,
          allowNonZeroExit: true,
          timeoutMs: DEFAULT_TIMEOUT_MS,
        })
        .pipe(
          Effect.mapError((error) => fromVcsError({ command: "gh", cwd: input.cwd }, error)),
          Effect.flatMap((pre) => {
            if (pre.exitCode === 0) {
              try {
                const parsed: unknown = JSON.parse(pre.stdout);
                if (
                  parsed !== null &&
                  typeof parsed === "object" &&
                  "state" in parsed &&
                  typeof parsed.state === "string" &&
                  isMergedPrState(parsed.state)
                ) {
                  const mergeCommit = "mergeCommit" in parsed ? parsed.mergeCommit : null;
                  const oid =
                    mergeCommit !== null &&
                    typeof mergeCommit === "object" &&
                    "oid" in mergeCommit &&
                    typeof mergeCommit.oid === "string"
                      ? mergeCommit.oid.trim()
                      : null;
                  return Effect.succeed(oid && oid.length > 0 ? oid : null);
                }
              } catch {
                // Fall through to merge when JSON is unreadable.
              }
            }
            return process
              .run({
                operation: "GitHubCli.mergePullRequest",
                command: "gh",
                args: ghPrArgs("merge", input.reference, ["--squash", "--delete-branch"]),
                cwd: input.cwd,
                allowNonZeroExit: true,
                timeoutMs: DEFAULT_TIMEOUT_MS,
              })
              .pipe(
                Effect.mapError((error) => fromVcsError({ command: "gh", cwd: input.cwd }, error)),
                Effect.flatMap((result): Effect.Effect<string | null, GitHubCliError> => {
                  if (result.exitCode === 0) {
                    return execute({
                      cwd: input.cwd,
                      args: ghPrArgs("view", input.reference, [
                        "--json",
                        "mergeCommit",
                        "--jq",
                        ".mergeCommit.oid",
                      ]),
                    }).pipe(
                      Effect.orElseSucceed(() => ({ stdout: "" }) as { stdout: string }),
                      Effect.map((view) => {
                        const trimmed = view.stdout.trim();
                        return trimmed.length > 0 ? trimmed : null;
                      }),
                    );
                  }
                  const kind = VcsProcess.classifyNonZeroExit("gh", result.stderr);
                  const context = { command: "gh" as const, cwd: input.cwd, cause: result };
                  if (kind === "authentication") {
                    return Effect.fail(new GitHubCliAuthenticationError(context));
                  }
                  if (kind === "not-found") {
                    return Effect.fail(new GitHubPullRequestNotFoundError(context));
                  }
                  const output = `${result.stderr}\n${result.stdout}`.trim();
                  if (isAlreadyMergedGhOutput(output)) {
                    return Effect.succeed(null);
                  }
                  const reason =
                    output.length > 0
                      ? output.split("\n").filter(Boolean).join(" ").slice(0, 300)
                      : `gh pr merge exited ${result.exitCode}`;
                  return Effect.fail(new GitHubCliCommandError({ ...context, reason }));
                }),
              );
          }),
        ),
    // Same shape as `mergePullRequest`: `gh pr close` exits non-zero on an
    // already-merged or already-closed PR, and that reason is what the board
    // shows, so it is classified the same way rather than redacted by a
    // generic transport error. --repo from URL when present (detached HEAD).
    closePullRequest: (input) =>
      process
        .run({
          operation: "GitHubCli.closePullRequest",
          command: "gh",
          args: ghPrArgs("close", input.reference),
          cwd: input.cwd,
          allowNonZeroExit: true,
          timeoutMs: DEFAULT_TIMEOUT_MS,
        })
        .pipe(
          Effect.mapError((error) => fromVcsError({ command: "gh", cwd: input.cwd }, error)),
          Effect.flatMap((result): Effect.Effect<void, GitHubCliError> => {
            if (result.exitCode === 0) return Effect.void;
            const kind = VcsProcess.classifyNonZeroExit("gh", result.stderr);
            const context = { command: "gh" as const, cwd: input.cwd, cause: result };
            if (kind === "authentication") {
              return Effect.fail(new GitHubCliAuthenticationError(context));
            }
            if (kind === "not-found") {
              return Effect.fail(new GitHubPullRequestNotFoundError(context));
            }
            const output = `${result.stderr}\n${result.stdout}`.trim();
            if (isAlreadyMergedGhOutput(output)) return Effect.void;
            const reason =
              output.length > 0
                ? output.split("\n").filter(Boolean).join(" ").slice(0, 300)
                : `gh pr close exited ${result.exitCode}`;
            return Effect.fail(new GitHubCliCommandError({ ...context, reason }));
          }),
        ),
    getDefaultBranch: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      }).pipe(
        Effect.map((value) => {
          const trimmed = value.stdout.trim();
          return trimmed.length > 0 ? trimmed : null;
        }),
      ),
    checkoutPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "checkout", input.reference, ...(input.force ? ["--force"] : [])],
      }).pipe(Effect.asVoid),
    getPullRequestChecks: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "view",
          input.reference,
          "--json",
          "statusCheckRollup,createdAt,state,mergedAt",
        ],
      }).pipe(Effect.map((result) => result.stdout)),
  });
});

export const layer = Layer.effect(GitHubCli, make);
