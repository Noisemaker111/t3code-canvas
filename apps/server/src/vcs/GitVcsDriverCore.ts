import * as Arr from "effect/Array";
import * as Cache from "effect/Cache";
import * as Data from "effect/Data";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  GitCommandError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewSource,
  type VcsRef,
} from "@t3tools/contracts";
import { dedupeRemoteBranchesWithLocalMatches } from "@t3tools/shared/git";
import { compactTraceAttributes } from "@t3tools/shared/observability";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { commitIdentityArgs } from "../git/commitIdentity.ts";
import { gitCommandDuration, gitCommandsTotal, withMetrics } from "../observability/Metrics.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { withGitFailureDetail } from "./gitFailureDetail.ts";
import { isCorruptHeadGitStderr, parseReflogTargets } from "./headRepair.ts";
import {
  parseRemoteNames,
  parseRemoteNamesInGitOrder,
  parseRemoteRefWithRemoteNames,
} from "../git/remoteRefs.ts";
import { resolveWorktreeRoot, sanitizeWorktreeSegment } from "./worktreeLayout.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";
const PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES = 49_000;
const RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES = 59_000;
const REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES = 120_000;
const REVIEW_UNTRACKED_DIFF_MAX_OUTPUT_BYTES = 80_000;
const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 120_000;
const STATUS_UPSTREAM_REFRESH_INTERVAL = Duration.seconds(15);
const STATUS_UPSTREAM_REFRESH_TIMEOUT = Duration.seconds(5);

const STATUS_UPSTREAM_REFRESH_FAILURE_COOLDOWN = Duration.seconds(5);
const STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY = 2_048;
const STATUS_UPSTREAM_REFRESH_ENV = Object.freeze({
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS: "",
  SSH_ASKPASS_REQUIRE: "never",
} satisfies NodeJS.ProcessEnv);
const DEFAULT_BASE_BRANCH_CANDIDATES = ["main", "master"] as const;
const GIT_LIST_BRANCHES_DEFAULT_LIMIT = 100;
const RIFT_FAILURE_OUTPUT_MAX_CHARS = 4_000;
const RIFT_MARKER_FILE_NAME = ".rift";

// On-disk `.rift` markers can outlive the local registry (DB wipe, reinstall,
// restored checkout). Rift then refuses `init --here` / `list` until the stale
// marker is cleared so a fresh registration can land.
const isStaleRiftMarkerOutput = (output: string): boolean =>
  /rift marker (does not match the registry|belongs to an unknown registry entry)/i.test(output);

// Rift writes the actionable reason for a failure (missing reflink support, a
// dirty checkout, an unknown ref, ...) to stderr. Surface it in the error detail
// so the operator sees why "rift" exited instead of a bare "non-zero status".
const describeRiftFailure = (cwd: string, stdout: string, stderr: string): string => {
  const riftOutput = (stderr.trim().length > 0 ? stderr : stdout).trim();
  const parts = ["Rift command exited with a non-zero status."];
  if (riftOutput.length > 0) {
    parts.push(
      riftOutput.length > RIFT_FAILURE_OUTPUT_MAX_CHARS
        ? `${riftOutput.slice(0, RIFT_FAILURE_OUTPUT_MAX_CHARS)}…`
        : riftOutput,
    );
  }
  if (/copy-on-write|reflink/i.test(riftOutput)) {
    parts.push(
      `The source directory (${cwd}) is on a filesystem without copy-on-write reflink support. ` +
        "Rift workspaces require a reflink-capable filesystem such as Btrfs; move the project onto " +
        "the Btrfs-backed project store before creating workspaces.",
    );
  }
  return parts.join(" ");
};

const NON_REPOSITORY_STATUS_DETAILS = Object.freeze<GitVcsDriver.GitStatusDetails>({
  isRepo: false,
  hasOriginRemote: false,
  isDefaultBranch: false,
  branch: null,
  upstreamRef: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
});
const NON_REPOSITORY_REMOTE_STATUS_DETAILS = Object.freeze<GitVcsDriver.GitRemoteStatusDetails>({
  isRepo: false,
  isDefaultBranch: false,
  branch: null,
  upstreamRef: null,
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
});

type TraceTailState = {
  processedChars: number;
  remainder: string;
};

class StatusRemoteRefreshCacheKey extends Data.Class<{
  gitCommonDir: string;
  remoteName: string;
}> {}

interface ExecuteGitOptions {
  stdin?: string | undefined;
  timeoutMs?: number | undefined;
  allowNonZeroExit?: boolean | undefined;
  fallbackErrorDetail?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  maxOutputBytes?: number | undefined;
  appendTruncationMarker?: boolean | undefined;
  progress?: GitVcsDriver.ExecuteGitProgress | undefined;
}

function parseBranchAb(value: string): { ahead: number; behind: number } {
  const match = value.match(/^\+(\d+)\s+-(\d+)$/);
  if (!match) return { ahead: 0, behind: 0 };
  return {
    ahead: Number(match[1] ?? "0"),
    behind: Number(match[2] ?? "0"),
  };
}

function parseNumstatEntries(
  stdout: string,
): Array<{ path: string; insertions: number; deletions: number }> {
  const entries: Array<{ path: string; insertions: number; deletions: number }> = [];
  for (const line of stdout.split(/\r?\n/g)) {
    if (line.trim().length === 0) continue;
    const [addedRaw, deletedRaw, ...pathParts] = line.split("\t");
    const rawPath =
      pathParts.length > 1 ? (pathParts.at(-1) ?? "").trim() : pathParts.join("\t").trim();
    if (rawPath.length === 0) continue;
    const added = Number.parseInt(addedRaw ?? "0", 10);
    const deleted = Number.parseInt(deletedRaw ?? "0", 10);
    const renameArrowIndex = rawPath.indexOf(" => ");
    const normalizedPath =
      renameArrowIndex >= 0 ? rawPath.slice(renameArrowIndex + " => ".length).trim() : rawPath;
    entries.push({
      path: normalizedPath.length > 0 ? normalizedPath : rawPath,
      insertions: Number.isFinite(added) ? added : 0,
      deletions: Number.isFinite(deleted) ? deleted : 0,
    });
  }
  return entries;
}

function parsePorcelainPath(line: string): string | null {
  if (line.startsWith("? ") || line.startsWith("! ")) {
    const simple = line.slice(2).trim();
    return simple.length > 0 ? simple : null;
  }

  if (!(line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u "))) {
    return null;
  }

  const tabIndex = line.indexOf("\t");
  if (tabIndex >= 0) {
    const fromTab = line.slice(tabIndex + 1);
    const [filePath] = fromTab.split("\t");
    return filePath?.trim().length ? filePath.trim() : null;
  }

  const parts = line.trim().split(/\s+/g);
  const filePath = parts.at(-1) ?? "";
  return filePath.length > 0 ? filePath : null;
}

function parseBranchLine(line: string): { name: string; current: boolean } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  const name = trimmed.replace(/^[*+]\s+/, "");
  // Exclude symbolic refs like: "origin/HEAD -> origin/main".
  // Exclude detached HEAD pseudo-refs like: "(HEAD detached at origin/main)".
  if (name.includes(" -> ") || name.startsWith("(")) return null;

  return {
    name,
    current: trimmed.startsWith("* "),
  };
}

function filterBranchesForListQuery(
  refs: ReadonlyArray<VcsRef>,
  query?: string,
): ReadonlyArray<VcsRef> {
  if (!query) {
    return refs;
  }

  const normalizedQuery = query.toLowerCase();
  return refs.filter((refName) => refName.name.toLowerCase().includes(normalizedQuery));
}

function paginateBranches(input: {
  refs: ReadonlyArray<VcsRef>;
  cursor?: number | undefined;
  limit?: number | undefined;
}): {
  refs: ReadonlyArray<VcsRef>;
  nextCursor: number | null;
  totalCount: number;
} {
  const cursor = input.cursor ?? 0;
  const limit = input.limit ?? GIT_LIST_BRANCHES_DEFAULT_LIMIT;
  const totalCount = input.refs.length;
  const refs = input.refs.slice(cursor, cursor + limit);
  const nextCursor = cursor + refs.length < totalCount ? cursor + refs.length : null;

  return {
    refs,
    nextCursor,
    totalCount,
  };
}

function splitNullSeparatedPaths(input: string, truncated: boolean): string[] {
  const parts = input.split("\0");
  if (parts.length === 0) return [];

  if (truncated && parts[parts.length - 1]?.length) {
    parts.pop();
  }

  return parts.filter((value) => value.length > 0);
}

export function splitNullSeparatedGitStdoutPaths(
  result: Pick<GitVcsDriver.ExecuteGitResult, "stdout" | "stdoutTruncated">,
): string[] {
  return splitNullSeparatedPaths(result.stdout, result.stdoutTruncated);
}

function sanitizeRemoteName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "fork";
}

function normalizeRemoteUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

function parseUpstreamRefWithRemoteNames(
  upstreamRef: string,
  remoteNames: ReadonlyArray<string>,
): { upstreamRef: string; remoteName: string; branchName: string } | null {
  const parsed = parseRemoteRefWithRemoteNames(upstreamRef, remoteNames);
  if (!parsed) {
    return null;
  }

  return {
    upstreamRef,
    remoteName: parsed.remoteName,
    branchName: parsed.branchName,
  };
}

function parseUpstreamRefByFirstSeparator(
  upstreamRef: string,
): { upstreamRef: string; remoteName: string; branchName: string } | null {
  const separatorIndex = upstreamRef.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === upstreamRef.length - 1) {
    return null;
  }

  const remoteName = upstreamRef.slice(0, separatorIndex).trim();
  const branchName = upstreamRef.slice(separatorIndex + 1).trim();
  if (remoteName.length === 0 || branchName.length === 0) {
    return null;
  }

  return {
    upstreamRef,
    remoteName,
    branchName,
  };
}

function parseTrackingBranchByUpstreamRef(stdout: string, upstreamRef: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      continue;
    }
    const [branchNameRaw, upstreamBranchRaw = ""] = trimmedLine.split("\t");
    const branchName = branchNameRaw?.trim() ?? "";
    const candidateUpstreamRef = upstreamBranchRaw.trim();
    if (branchName.length === 0 || candidateUpstreamRef.length === 0) {
      continue;
    }
    if (candidateUpstreamRef === upstreamRef) {
      return branchName;
    }
  }

  return null;
}

function deriveLocalBranchNameFromRemoteRef(branchName: string): string | null {
  const separatorIndex = branchName.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === branchName.length - 1) {
    return null;
  }
  const localBranch = branchName.slice(separatorIndex + 1).trim();
  return localBranch.length > 0 ? localBranch : null;
}

function gitCommandContext(
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
) {
  return {
    operation: input.operation,
    command: "git",
    cwd: input.cwd,
    argumentCount: input.args.length,
  } as const;
}

function parseDefaultBranchFromRemoteHeadRef(value: string, remoteName: string): string | null {
  const trimmed = value.trim();
  const prefix = `refs/remotes/${remoteName}/`;
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  const refName = trimmed.slice(prefix.length).trim();
  return refName.length > 0 ? refName : null;
}

function isMissingGitCwdError(error: GitCommandError): boolean {
  if (!(error.cause instanceof PlatformError.PlatformError)) {
    return false;
  }

  const reason = error.cause.reason;
  if (reason._tag === "NotFound") {
    return reason.pathOrDescriptor === error.cwd;
  }

  return (
    reason._tag === "BadResource" &&
    reason.pathOrDescriptor === error.cwd &&
    typeof reason.cause === "object" &&
    reason.cause !== null &&
    "code" in reason.cause &&
    reason.cause.code === "ENOTDIR"
  );
}

function isNonRepositoryGitStderr(stderr: string): boolean {
  return stderr.toLowerCase().includes("not a git repository");
}

interface Trace2Monitor {
  readonly env: NodeJS.ProcessEnv;
  readonly flush: Effect.Effect<void, never>;
}

const nowUnixNano = DateTime.now.pipe(
  Effect.map((now) => BigInt(DateTime.toEpochMillis(now)) * 1_000_000n),
);

const addCurrentSpanEvent = (name: string, attributes: Record<string, unknown>) =>
  Effect.gen(function* () {
    const span = yield* Effect.currentSpan;
    const timestamp = yield* nowUnixNano;
    yield* Effect.sync(() => {
      span.event(name, timestamp, compactTraceAttributes(attributes));
    });
  }).pipe(
    Effect.catchTags({
      NoSuchElementError: () => Effect.void,
    }),
  );

function trace2ChildKey(record: Record<string, unknown>): string | null {
  const childId = record.child_id;
  if (typeof childId === "number" || typeof childId === "string") {
    return String(childId);
  }
  const hookName = record.hook_name;
  return typeof hookName === "string" && hookName.trim().length > 0 ? hookName.trim() : null;
}

const Trace2Record = Schema.Record(Schema.String, Schema.Unknown);

const createTrace2Monitor = Effect.fn("createTrace2Monitor")(function* (
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
  progress: GitVcsDriver.ExecuteGitProgress | undefined,
): Effect.fn.Return<
  Trace2Monitor,
  PlatformError.PlatformError,
  Scope.Scope | FileSystem.FileSystem | Path.Path
> {
  if (!progress?.onHookStarted && !progress?.onHookFinished) {
    return {
      env: {},
      flush: Effect.void,
    };
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const traceFilePath = yield* fs.makeTempFileScoped({
    prefix: `t3code-git-trace2-${process.pid}-`,
    suffix: ".json",
  });
  const hookStartByChildKey = new Map<string, { hookName: string; startedAtMs: number }>();
  const traceTailState = yield* Ref.make<TraceTailState>({
    processedChars: 0,
    remainder: "",
  });

  const handleTraceLine = Effect.fn("handleTraceLine")(function* (line: string) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      return;
    }

    const traceRecord = decodeJsonResult(Trace2Record)(trimmedLine);
    if (Result.isFailure(traceRecord)) {
      yield* Effect.logDebug(
        `GitVcsDriver.trace2: failed to parse trace line for ${input.operation} in ${input.cwd} (${input.args.length} arguments)`,
        traceRecord.failure,
      );
      return;
    }

    if (traceRecord.success.child_class !== "hook") {
      return;
    }

    const event = traceRecord.success.event;
    const childKey = trace2ChildKey(traceRecord.success);
    if (childKey === null) {
      return;
    }
    const started = hookStartByChildKey.get(childKey);
    const hookNameFromEvent =
      typeof traceRecord.success.hook_name === "string" ? traceRecord.success.hook_name.trim() : "";
    const hookName = hookNameFromEvent.length > 0 ? hookNameFromEvent : (started?.hookName ?? "");
    if (hookName.length === 0) {
      return;
    }

    if (event === "child_start") {
      const now = yield* DateTime.now;
      hookStartByChildKey.set(childKey, { hookName, startedAtMs: DateTime.toEpochMillis(now) });
      yield* addCurrentSpanEvent("git.hook.started", {
        hookName,
      });
      if (progress.onHookStarted) {
        yield* progress.onHookStarted(hookName);
      }
      return;
    }

    if (event === "child_exit") {
      hookStartByChildKey.delete(childKey);
      const code = traceRecord.success.exitCode;
      const exitCode = typeof code === "number" && Number.isInteger(code) ? code : null;
      const now = yield* DateTime.now;
      const durationMs = started
        ? Math.max(0, DateTime.toEpochMillis(now) - started.startedAtMs)
        : null;
      yield* addCurrentSpanEvent("git.hook.finished", {
        hookName: started?.hookName ?? hookName,
        exitCode,
        durationMs,
      });
      if (progress.onHookFinished) {
        yield* progress.onHookFinished({
          hookName: started?.hookName ?? hookName,
          exitCode,
          durationMs,
        });
      }
    }
  });

  const deltaMutex = yield* Semaphore.make(1);
  const readTraceDelta = deltaMutex.withPermit(
    fs.readFileString(traceFilePath).pipe(
      Effect.flatMap((contents) =>
        Effect.uninterruptible(
          Ref.modify(traceTailState, ({ processedChars, remainder }) => {
            if (contents.length <= processedChars) {
              return [[], { processedChars, remainder }];
            }

            const appended = contents.slice(processedChars);
            const combined = remainder + appended;
            const lines = combined.split("\n");
            const nextRemainder = lines.pop() ?? "";

            return [
              lines.map((line) => line.replace(/\r$/, "")),
              {
                processedChars: contents.length,
                remainder: nextRemainder,
              },
            ];
          }).pipe(
            Effect.flatMap((lines) => Effect.forEach(lines, handleTraceLine, { discard: true })),
          ),
        ),
      ),
      Effect.ignore({ log: true }),
    ),
  );
  const traceFileName = path.basename(traceFilePath);
  yield* Stream.runForEach(fs.watch(traceFilePath), (event) => {
    const eventPath = event.path;
    const isTargetTraceEvent =
      eventPath === traceFilePath ||
      eventPath === traceFileName ||
      path.basename(eventPath) === traceFileName;
    if (!isTargetTraceEvent) return Effect.void;
    return readTraceDelta;
  }).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

  const finalizeTrace2Monitor = Effect.fn("finalizeTrace2Monitor")(function* () {
    yield* readTraceDelta;
    const finalLine = yield* Ref.modify(traceTailState, ({ processedChars, remainder }) => [
      remainder.trim(),
      {
        processedChars,
        remainder: "",
      },
    ]);
    if (finalLine.length > 0) {
      yield* handleTraceLine(finalLine);
    }
  });

  yield* Effect.addFinalizer(finalizeTrace2Monitor);

  return {
    env: {
      GIT_TRACE2_EVENT: traceFilePath,
    },
    flush: readTraceDelta,
  };
});

const collectOutput = Effect.fnUntraced(function* (
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  maxOutputBytes: number,
  appendTruncationMarker: boolean,
  onLine: ((line: string) => Effect.Effect<void, never>) | undefined,
): Effect.fn.Return<{ readonly text: string; readonly truncated: boolean }, GitCommandError> {
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let lineBuffer = "";
  let truncated = false;

  const emitCompleteLines = Effect.fnUntraced(function* (flush: boolean) {
    let newlineIndex = lineBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = lineBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      if (line.length > 0 && onLine) {
        yield* onLine(line);
      }
      newlineIndex = lineBuffer.indexOf("\n");
    }

    if (flush) {
      const trailing = lineBuffer.replace(/\r$/, "");
      lineBuffer = "";
      if (trailing.length > 0 && onLine) {
        yield* onLine(trailing);
      }
    }
  });

  const processChunk = Effect.fnUntraced(function* (chunk: Uint8Array) {
    if (appendTruncationMarker && truncated) {
      return;
    }
    const nextBytes = bytes + chunk.byteLength;
    if (!appendTruncationMarker && nextBytes > maxOutputBytes) {
      return yield* new GitCommandError({
        ...gitCommandContext(input),
        detail: `Git output exceeded ${maxOutputBytes} bytes and was truncated.`,
        outputLength: nextBytes,
      });
    }

    const chunkToDecode =
      appendTruncationMarker && nextBytes > maxOutputBytes
        ? chunk.subarray(0, Math.max(0, maxOutputBytes - bytes))
        : chunk;
    bytes += chunkToDecode.byteLength;
    truncated = appendTruncationMarker && nextBytes > maxOutputBytes;

    const decoded = decoder.decode(chunkToDecode, { stream: !truncated });
    text += decoded;
    lineBuffer += decoded;
    yield* emitCompleteLines(false);
  });

  yield* Stream.runForEach(stream, processChunk).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new GitCommandError({
          ...gitCommandContext(input),
          detail: "Failed to read Git process output.",
          cause,
        }),
    }),
  );

  const remainder = truncated ? "" : decoder.decode();
  text += remainder;
  lineBuffer += remainder;
  yield* emitCompleteLines(true);
  return {
    text,
    truncated,
  };
});

export const makeGitVcsDriverCore = Effect.fn("makeGitVcsDriverCore")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;

  const executeRaw: GitVcsDriver.GitVcsDriver["Service"]["execute"] = Effect.fnUntraced(
    function* (input) {
      const commandInput = {
        ...input,
        args: [...input.args],
      } as const;
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const appendTruncationMarker = input.appendTruncationMarker ?? false;

      const runGitCommand = Effect.fn("runGitCommand")(function* () {
        const trace2Monitor = yield* createTrace2Monitor(commandInput, input.progress).pipe(
          Effect.provideService(Path.Path, path),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                ...gitCommandContext(commandInput),
                detail: "Failed to create Git trace monitor.",
                cause,
              }),
          ),
        );
        const child = yield* commandSpawner
          .spawn(
            ChildProcess.make("git", commandInput.args, {
              cwd: commandInput.cwd,
              env: {
                ...process.env,
                ...input.env,
                ...trace2Monitor.env,
              },
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new GitCommandError({
                  ...gitCommandContext(commandInput),
                  detail: "Failed to spawn Git process.",
                  cause,
                }),
            ),
          );

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectOutput(
              commandInput,
              child.stdout,
              maxOutputBytes,
              appendTruncationMarker,
              input.progress?.onStdoutLine,
            ),
            collectOutput(
              commandInput,
              child.stderr,
              maxOutputBytes,
              appendTruncationMarker,
              input.progress?.onStderrLine,
            ),
            child.exitCode.pipe(
              Effect.mapError(
                (cause) =>
                  new GitCommandError({
                    ...gitCommandContext(commandInput),
                    detail: "Failed to read Git process exit code.",
                    cause,
                  }),
              ),
            ),
            input.stdin === undefined
              ? Effect.void
              : Stream.run(Stream.encodeText(Stream.make(input.stdin)), child.stdin).pipe(
                  Effect.mapError(
                    (cause) =>
                      new GitCommandError({
                        ...gitCommandContext(commandInput),
                        detail: "Failed to write Git process input.",
                        cause,
                      }),
                  ),
                ),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.map(([stdout, stderr, exitCode]) => [stdout, stderr, exitCode] as const));
        yield* trace2Monitor.flush;

        if (!input.allowNonZeroExit && exitCode !== 0) {
          return yield* new GitCommandError({
            ...gitCommandContext(commandInput),
            detail: "Git command exited with a non-zero status.",
            exitCode,
            stdoutLength: stdout.text.length,
            stderrLength: stderr.text.length,
          });
        }

        return {
          exitCode,
          stdout: stdout.text,
          stderr: stderr.text,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        } satisfies GitVcsDriver.ExecuteGitResult;
      });

      return yield* runGitCommand().pipe(
        Effect.scoped,
        Effect.timeoutOption(timeoutMs),
        Effect.flatMap((result) =>
          Option.match(result, {
            onNone: () =>
              Effect.fail(
                new GitCommandError({
                  ...gitCommandContext(commandInput),
                  detail: "Git command timed out.",
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
    },
  );

  const execute: GitVcsDriver.GitVcsDriver["Service"]["execute"] = (input) =>
    executeRaw(input).pipe(
      withMetrics({
        counter: gitCommandsTotal,
        timer: gitCommandDuration,
        attributes: {
          operation: input.operation,
        },
      }),
      Effect.withSpan(input.operation, {
        kind: "client",
        attributes: {
          "git.operation": input.operation,
          "git.cwd": input.cwd,
          "git.args_count": input.args.length,
        },
      }),
    );

  const executeGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<GitVcsDriver.ExecuteGitResult, GitCommandError> =>
    execute({
      operation,
      cwd,
      args,
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      allowNonZeroExit: true,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: options.appendTruncationMarker }
        : {}),
      ...(options.progress ? { progress: options.progress } : {}),
    }).pipe(
      Effect.flatMap((result) => {
        if (options.allowNonZeroExit || result.exitCode === 0) {
          return Effect.succeed(result);
        }
        return Effect.fail(
          new GitCommandError({
            ...gitCommandContext({ operation, cwd, args }),
            detail: options.fallbackErrorDetail ?? "Git command exited with a non-zero status.",
            ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
            stdoutLength: result.stdout.length,
            stderrLength: result.stderr.length,
          }),
        );
      }),
    );

  const executeGitWithStableDiagnostics = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<GitVcsDriver.ExecuteGitResult, GitCommandError> =>
    executeGit(operation, cwd, args, {
      ...options,
      env: {
        ...options.env,
        LC_ALL: "C",
      },
    });

  const executeRift = Effect.fn("GitVcsDriver.executeRift")(function* (
    operation: string,
    cwd: string,
    args: readonly string[],
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    const commandInput = { operation, cwd, args: [...args] } as const;
    const run = Effect.gen(function* () {
      const child = yield* commandSpawner
        .spawn(
          ChildProcess.make("rift", commandInput.args, {
            cwd,
            env: process.env,
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                ...gitCommandContext(commandInput),
                command: "rift",
                detail: "Failed to spawn Rift. Install rift-snapshot before creating workspaces.",
                cause,
              }),
          ),
        );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectOutput(commandInput, child.stdout, DEFAULT_MAX_OUTPUT_BYTES, false, undefined),
          collectOutput(commandInput, child.stderr, DEFAULT_MAX_OUTPUT_BYTES, false, undefined),
          child.exitCode.pipe(
            Effect.mapError(
              (cause) =>
                new GitCommandError({
                  ...gitCommandContext(commandInput),
                  command: "rift",
                  detail: "Failed to read the Rift process exit code.",
                  cause,
                }),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        return yield* new GitCommandError({
          ...gitCommandContext(commandInput),
          command: "rift",
          detail: describeRiftFailure(cwd, stdout.text, stderr.text),
          exitCode,
          stdoutLength: stdout.text.length,
          stderrLength: stderr.text.length,
        });
      }
      return stdout.text.trim();
    });

    const result = yield* run.pipe(Effect.scoped, Effect.timeoutOption(timeoutMs));
    return yield* Option.match(result, {
      onNone: () =>
        Effect.fail(
          new GitCommandError({
            ...gitCommandContext(commandInput),
            command: "rift",
            detail: "Rift command timed out.",
          }),
        ),
      onSome: Effect.succeed,
    });
  });

  const runGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<void, GitCommandError> =>
    executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(Effect.asVoid);

  const runGitStdout = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<string, GitCommandError> =>
    executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(
      Effect.map((result) => result.stdout),
    );

  const runGitStdoutWithOptions = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<string, GitCommandError> =>
    executeGit(operation, cwd, args, options).pipe(
      Effect.map((result) =>
        result.stdoutTruncated ? `${result.stdout}${OUTPUT_TRUNCATED_MARKER}` : result.stdout,
      ),
    );

  const branchExists = (cwd: string, refName: string): Effect.Effect<boolean, GitCommandError> =>
    executeGit(
      "GitVcsDriver.branchExists",
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/heads/${refName}`],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      },
    ).pipe(Effect.map((result) => result.exitCode === 0));

  const resolveAvailableBranchName = Effect.fn("resolveAvailableBranchName")(function* (
    cwd: string,
    desiredBranch: string,
  ) {
    const isDesiredTaken = yield* branchExists(cwd, desiredBranch);
    if (!isDesiredTaken) {
      return desiredBranch;
    }

    for (let suffix = 1; suffix <= 100; suffix += 1) {
      const candidate = `${desiredBranch}-${suffix}`;
      const isCandidateTaken = yield* branchExists(cwd, candidate);
      if (!isCandidateTaken) {
        return candidate;
      }
    }

    return yield* new GitCommandError({
      ...gitCommandContext({
        operation: "GitVcsDriver.renameBranch",
        cwd,
        args: ["branch", "-m", "--", desiredBranch],
      }),
      detail: `Could not find an available branch name for '${desiredBranch}'.`,
    });
  });

  const resolveCurrentUpstream = Effect.fn("resolveCurrentUpstream")(function* (cwd: string) {
    const upstreamRef = yield* runGitStdout(
      "GitVcsDriver.resolveCurrentUpstream",
      cwd,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));

    if (upstreamRef.length === 0 || upstreamRef === "@{upstream}") {
      return null;
    }

    const remoteNames = yield* runGitStdout("GitVcsDriver.listRemoteNames", cwd, ["remote"]).pipe(
      Effect.map(parseRemoteNames),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );
    return (
      parseUpstreamRefWithRemoteNames(upstreamRef, remoteNames) ??
      parseUpstreamRefByFirstSeparator(upstreamRef)
    );
  });

  const fetchRemoteForStatus = (
    gitCommonDir: string,
    remoteName: string,
  ): Effect.Effect<void, GitCommandError> => {
    const fetchCwd =
      path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
    return executeGit(
      "GitVcsDriver.fetchRemoteForStatus",
      fetchCwd,
      ["--git-dir", gitCommonDir, "fetch", "--quiet", "--no-tags", remoteName],
      {
        allowNonZeroExit: true,
        env: STATUS_UPSTREAM_REFRESH_ENV,
        timeoutMs: Duration.toMillis(STATUS_UPSTREAM_REFRESH_TIMEOUT),
      },
    ).pipe(Effect.asVoid);
  };

  const resolveGitCommonDir = Effect.fn("resolveGitCommonDir")(function* (cwd: string) {
    const gitCommonDir = yield* runGitStdout("GitVcsDriver.resolveGitCommonDir", cwd, [
      "rev-parse",
      "--git-common-dir",
    ]).pipe(Effect.map((stdout) => stdout.trim()));
    return path.isAbsolute(gitCommonDir) ? gitCommonDir : path.resolve(cwd, gitCommonDir);
  });

  const refreshStatusRemoteCacheEntry = Effect.fn("refreshStatusRemoteCacheEntry")(function* (
    cacheKey: StatusRemoteRefreshCacheKey,
  ) {
    yield* fetchRemoteForStatus(cacheKey.gitCommonDir, cacheKey.remoteName);
    return true as const;
  });

  const statusRemoteRefreshCache = yield* Cache.makeWith(refreshStatusRemoteCacheEntry, {
    capacity: STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY,
    // Keep successful refreshes warm and briefly back off failed refreshes to avoid retry storms.
    timeToLive: (exit) =>
      Exit.isSuccess(exit)
        ? STATUS_UPSTREAM_REFRESH_INTERVAL
        : STATUS_UPSTREAM_REFRESH_FAILURE_COOLDOWN,
  });

  const refreshStatusUpstreamIfStale = Effect.fn("refreshStatusUpstreamIfStale")(function* (
    cwd: string,
  ) {
    const upstream = yield* resolveCurrentUpstream(cwd);
    if (!upstream) return;
    const gitCommonDir = yield* resolveGitCommonDir(cwd);
    yield* Cache.get(
      statusRemoteRefreshCache,
      new StatusRemoteRefreshCacheKey({
        gitCommonDir,
        remoteName: upstream.remoteName,
      }),
    );
  });

  const resolveDefaultBranchName = (
    cwd: string,
    remoteName: string,
  ): Effect.Effect<string | null, GitCommandError> =>
    executeGit(
      "GitVcsDriver.resolveDefaultBranchName",
      cwd,
      ["symbolic-ref", `refs/remotes/${remoteName}/HEAD`],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return null;
        }
        return parseDefaultBranchFromRemoteHeadRef(result.stdout, remoteName);
      }),
    );

  const remoteBranchExists = (
    cwd: string,
    remoteName: string,
    refName: string,
  ): Effect.Effect<boolean, GitCommandError> =>
    executeGit(
      "GitVcsDriver.remoteBranchExists",
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/remotes/${remoteName}/${refName}`],
      {
        allowNonZeroExit: true,
      },
    ).pipe(Effect.map((result) => result.exitCode === 0));

  const listMatchingRemoteBranches = Effect.fn("listMatchingRemoteBranches")(function* (
    cwd: string,
    remoteName: string,
    branchPrefix: string,
  ) {
    const stdout = yield* runGitStdout("GitVcsDriver.listMatchingRemoteBranches", cwd, [
      "ls-remote",
      "--heads",
      remoteName,
      `refs/heads/${branchPrefix}*`,
    ]);
    const branches = new Map<string, string>();
    for (const line of stdout.split("\n")) {
      const [commitSha = "", ref = ""] = line.trim().split(/\s+/, 2);
      if (!ref.startsWith("refs/heads/") || commitSha.length === 0) continue;
      branches.set(ref.slice("refs/heads/".length), commitSha);
    }
    return branches;
  });

  const resolveAvailableRemoteBranchName = (
    branch: string,
    existingBranches: ReadonlyMap<string, string>,
  ): string | null => {
    const existingNames = new Set([...existingBranches.keys()].map((name) => name.toLowerCase()));
    for (let suffix = 2; suffix <= 100; suffix += 1) {
      const candidate = `${branch}-${suffix}`;
      if (!existingNames.has(candidate.toLowerCase())) return candidate;
    }
    return null;
  };

  const originRemoteExists = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
    executeGit("GitVcsDriver.originRemoteExists", cwd, ["remote", "get-url", "origin"], {
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => result.exitCode === 0));

  const listRemoteNames = (cwd: string): Effect.Effect<ReadonlyArray<string>, GitCommandError> =>
    runGitStdout("GitVcsDriver.listRemoteNames", cwd, ["remote"]).pipe(
      Effect.map(parseRemoteNamesInGitOrder),
    );

  const resolvePublishBranchName = Effect.fn("resolvePublishBranchName")(function* (
    cwd: string,
    branchName: string,
  ) {
    const remoteNames = yield* listRemoteNames(cwd).pipe(Effect.orElseSucceed(() => []));
    const parsedRemoteRef = parseRemoteRefWithRemoteNames(branchName, remoteNames);
    return parsedRemoteRef?.branchName ?? branchName;
  });

  const resolvePrimaryRemoteName = Effect.fn("resolvePrimaryRemoteName")(function* (cwd: string) {
    if (yield* originRemoteExists(cwd)) {
      return "origin";
    }
    const remotes = yield* listRemoteNames(cwd);
    const [firstRemote] = remotes;
    if (firstRemote) {
      return firstRemote;
    }
    return yield* new GitCommandError({
      ...gitCommandContext({
        operation: "GitVcsDriver.resolvePrimaryRemoteName",
        cwd,
        args: ["remote"],
      }),
      detail: "No git remote is configured for this repository.",
    });
  });

  const resolvePushRemoteName = Effect.fn("resolvePushRemoteName")(function* (
    cwd: string,
    refName: string,
  ) {
    const branchPushRemote = yield* runGitStdout(
      "GitVcsDriver.resolvePushRemoteName.branchPushRemote",
      cwd,
      ["config", "--get", `branch.${refName}.pushRemote`],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    if (branchPushRemote.length > 0) {
      return branchPushRemote;
    }

    const pushDefaultRemote = yield* runGitStdout(
      "GitVcsDriver.resolvePushRemoteName.remotePushDefault",
      cwd,
      ["config", "--get", "remote.pushDefault"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    if (pushDefaultRemote.length > 0) {
      return pushDefaultRemote;
    }

    return yield* resolvePrimaryRemoteName(cwd).pipe(Effect.orElseSucceed(() => null));
  });

  const ensureRemote: GitVcsDriver.GitVcsDriver["Service"]["ensureRemote"] = Effect.fn(
    "ensureRemote",
  )(function* (input) {
    const preferredName = sanitizeRemoteName(input.preferredName);
    const normalizedTargetUrl = normalizeRemoteUrl(input.url);
    const remoteFetchUrls = yield* runGitStdout(
      "GitVcsDriver.ensureRemote.listRemoteUrls",
      input.cwd,
      ["remote", "-v"],
    ).pipe(Effect.map((stdout) => parseRemoteFetchUrls(stdout)));

    for (const [remoteName, remoteUrl] of remoteFetchUrls.entries()) {
      if (normalizeRemoteUrl(remoteUrl) === normalizedTargetUrl) {
        return remoteName;
      }
    }

    let remoteName = preferredName;
    let suffix = 1;
    while (remoteFetchUrls.has(remoteName)) {
      remoteName = `${preferredName}-${suffix}`;
      suffix += 1;
    }

    yield* runGit("GitVcsDriver.ensureRemote.add", input.cwd, [
      "remote",
      "add",
      remoteName,
      input.url,
    ]);
    return remoteName;
  });

  const resolveBaseBranchForNoUpstream = Effect.fn("resolveBaseBranchForNoUpstream")(function* (
    cwd: string,
    refName: string,
  ) {
    const configuredBaseBranch = yield* runGitStdout(
      "GitVcsDriver.resolveBaseBranchForNoUpstream.config",
      cwd,
      ["config", "--get", `branch.${refName}.gh-merge-base`],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));

    const primaryRemoteName = yield* resolvePrimaryRemoteName(cwd).pipe(
      Effect.orElseSucceed(() => null),
    );
    const defaultBranch =
      primaryRemoteName === null ? null : yield* resolveDefaultBranchName(cwd, primaryRemoteName);
    const candidates = [
      configuredBaseBranch.length > 0 ? configuredBaseBranch : null,
      defaultBranch,
      ...DEFAULT_BASE_BRANCH_CANDIDATES,
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const remotePrefix =
        primaryRemoteName && primaryRemoteName !== "origin" ? `${primaryRemoteName}/` : null;
      const normalizedCandidate = candidate.startsWith("origin/")
        ? candidate.slice("origin/".length)
        : remotePrefix && candidate.startsWith(remotePrefix)
          ? candidate.slice(remotePrefix.length)
          : candidate;
      if (normalizedCandidate.length === 0 || normalizedCandidate === refName) {
        continue;
      }

      if (
        primaryRemoteName &&
        (yield* remoteBranchExists(cwd, primaryRemoteName, normalizedCandidate))
      ) {
        return `${primaryRemoteName}/${normalizedCandidate}`;
      }

      if (yield* branchExists(cwd, normalizedCandidate)) {
        return normalizedCandidate;
      }
    }

    return null;
  });

  const computeAheadCountAgainstBase = Effect.fn("computeAheadCountAgainstBase")(function* (
    cwd: string,
    refName: string,
  ) {
    const baseRef = yield* resolveBaseBranchForNoUpstream(cwd, refName);
    if (!baseRef) {
      return 0;
    }

    const result = yield* executeGit(
      "GitVcsDriver.computeAheadCountAgainstBase",
      cwd,
      ["rev-list", "--count", `${baseRef}..HEAD`],
      { allowNonZeroExit: true },
    );
    if (result.exitCode !== 0) {
      return 0;
    }

    const parsed = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  });

  const resolvesToCommit = (cwd: string, ref: string) =>
    executeGit(
      "GitVcsDriver.repairHead.resolve",
      cwd,
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      { allowNonZeroExit: true, timeoutMs: 10_000 },
    ).pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)));

  const reflogRecoveryCandidates = Effect.fn("reflogRecoveryCandidates")(function* (
    cwd: string,
    branchRef: string,
  ) {
    const reflogPath = yield* executeGit(
      "GitVcsDriver.repairHead.reflogPath",
      cwd,
      ["rev-parse", "--git-path", `logs/${branchRef}`],
      { allowNonZeroExit: true, timeoutMs: 10_000 },
    );
    const relative = reflogPath.exitCode === 0 ? reflogPath.stdout.trim() : "";
    if (relative.length === 0) return [];
    const absolute = path.isAbsolute(relative) ? relative : path.join(cwd, relative);
    const contents = yield* fileSystem
      .readFileString(absolute)
      .pipe(Effect.orElseSucceed(() => ""));
    return parseReflogTargets(contents);
  });

  const nearbyRefs = Effect.fn("nearbyRefs")(function* (cwd: string) {
    const result = yield* executeGit(
      "GitVcsDriver.repairHead.refs",
      cwd,
      ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"],
      { allowNonZeroExit: true, timeoutMs: 10_000 },
    );
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, 50);
  });

  const RECOVERY_BRANCH = "t3-head-recovery";

  const anchorHead = Effect.fn("anchorHead")(function* (
    cwd: string,
    branch: string | null,
    sha: string,
  ) {
    if (branch) {
      yield* executeGit(
        "GitVcsDriver.repairHead.updateRef",
        cwd,
        ["update-ref", `refs/heads/${branch}`, sha],
        { allowNonZeroExit: true, timeoutMs: 10_000 },
      );
      return;
    }
    yield* executeGit(
      "GitVcsDriver.repairHead.updateRecoveryRef",
      cwd,
      ["update-ref", `refs/heads/${RECOVERY_BRANCH}`, sha],
      { allowNonZeroExit: true, timeoutMs: 10_000 },
    );
    yield* executeGit(
      "GitVcsDriver.repairHead.symbolicRef",
      cwd,
      ["symbolic-ref", "HEAD", `refs/heads/${RECOVERY_BRANCH}`],
      { allowNonZeroExit: true, timeoutMs: 10_000 },
    );
  });

  /**
   * Re-anchor a HEAD that points at a missing object, preferring the branch's
   * own last good tip. Nothing in the working tree is touched: the commits this
   * would "lose" are already unreadable, and leaving the checkout wedged costs
   * the board every card in that project.
   */
  const repairCorruptHead = Effect.fn("repairCorruptHead")(function* (cwd: string) {
    if ((yield* resolvesToCommit(cwd, "HEAD")) !== null) {
      return { repaired: false, detail: "HEAD resolves" } as const;
    }

    const symbolic = yield* executeGit(
      "GitVcsDriver.repairHead.head",
      cwd,
      ["symbolic-ref", "--quiet", "HEAD"],
      { allowNonZeroExit: true, timeoutMs: 10_000 },
    );
    const branchRef = symbolic.exitCode === 0 ? symbolic.stdout.trim() : "";
    const branch = branchRef.startsWith("refs/heads/")
      ? branchRef.slice("refs/heads/".length)
      : null;

    const sources: string[] = [];
    if (branch) {
      sources.push(...(yield* reflogRecoveryCandidates(cwd, branchRef)));
      const upstream = `refs/remotes/origin/${branch}`;
      if ((yield* resolvesToCommit(cwd, upstream)) === null) {
        yield* executeGit(
          "GitVcsDriver.repairHead.fetch",
          cwd,
          ["fetch", "--quiet", "origin", branch],
          { allowNonZeroExit: true, timeoutMs: 60_000, env: STATUS_UPSTREAM_REFRESH_ENV },
        );
      }
      sources.push(upstream);
    }
    const originHead = yield* executeGit(
      "GitVcsDriver.repairHead.originHead",
      cwd,
      ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
      { allowNonZeroExit: true, timeoutMs: 10_000 },
    );
    if (originHead.exitCode === 0 && originHead.stdout.trim().length > 0) {
      sources.push(originHead.stdout.trim());
    }
    sources.push(...(yield* nearbyRefs(cwd)));

    for (const source of sources) {
      const sha = yield* resolvesToCommit(cwd, source);
      if (sha === null) continue;
      yield* anchorHead(cwd, branch, sha);
      if ((yield* resolvesToCommit(cwd, "HEAD")) === null) continue;
      return {
        repaired: true,
        detail: `re-anchored ${branch ?? "HEAD"} to ${source} (${sha.slice(0, 7)})`,
      } as const;
    }

    return {
      repaired: false,
      detail: `no commit in ${cwd} resolves, so HEAD cannot be re-anchored; the object store needs \`git fsck\` or a fresh clone`,
    } as const;
  });

  /**
   * Repair a checkout's HEAD in place where a corrupt HEAD is not the failure
   * being reported, only something that must not spread into a snapshot. Never
   * fails: the caller has its own error to raise if the checkout is unusable.
   */
  const healHead = Effect.fn("healHead")(function* (cwd: string) {
    const repair = yield* repairCorruptHead(cwd).pipe(
      Effect.catchTags({
        GitCommandError: (error) =>
          Effect.succeed({ repaired: false, detail: error.detail } as const),
      }),
    );
    if (repair.repaired) {
      yield* Effect.logWarning("git HEAD repair", { cwd, ...repair });
    }
    return repair;
  });

  /** A repair that failed once will fail the same way every poll after it. */
  const headRepairFailed = new Set<string>();

  const runStatusPorcelain = (cwd: string) =>
    executeGitWithStableDiagnostics(
      "GitVcsDriver.statusDetails.status",
      cwd,
      ["status", "--porcelain=2", "--branch"],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.catchTags({
        GitCommandError: (error) =>
          isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
      }),
    );

  const readStatusDetailsRemote = Effect.fn("readStatusDetailsRemote")(function* (cwd: string) {
    const branchResult = yield* executeGitWithStableDiagnostics(
      "GitVcsDriver.statusDetailsRemote.branch",
      cwd,
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.catchTags({
        GitCommandError: (error) =>
          isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
      }),
    );

    if (branchResult === null) {
      return NON_REPOSITORY_REMOTE_STATUS_DETAILS;
    }
    if (branchResult.exitCode !== 0) {
      if (isNonRepositoryGitStderr(branchResult.stderr)) {
        return NON_REPOSITORY_REMOTE_STATUS_DETAILS;
      }
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.statusDetailsRemote.branch",
          cwd,
          args: ["rev-parse", "--abbrev-ref", "HEAD"],
        }),
        detail: withGitFailureDetail("Git branch lookup failed.", branchResult),
        exitCode: branchResult.exitCode,
        stdoutLength: branchResult.stdout.length,
        stderrLength: branchResult.stderr.length,
      });
    }

    const branchValue = branchResult.stdout.trim();
    const branch = branchValue.length > 0 && branchValue !== "HEAD" ? branchValue : null;
    const upstream = yield* resolveCurrentUpstream(cwd);
    const upstreamRef = upstream?.upstreamRef ?? null;
    let aheadCount = 0;
    let behindCount = 0;

    if (upstreamRef) {
      const divergence = yield* executeGit(
        "GitVcsDriver.statusDetailsRemote.divergence",
        cwd,
        ["rev-list", "--left-right", "--count", `HEAD...${upstreamRef}`],
        { allowNonZeroExit: true },
      );
      if (divergence.exitCode === 0) {
        const [aheadRaw, behindRaw] = divergence.stdout.trim().split(/\s+/);
        const parsedAhead = Number.parseInt(aheadRaw ?? "0", 10);
        const parsedBehind = Number.parseInt(behindRaw ?? "0", 10);
        aheadCount = Number.isFinite(parsedAhead) ? Math.max(0, parsedAhead) : 0;
        behindCount = Number.isFinite(parsedBehind) ? Math.max(0, parsedBehind) : 0;
      }
    } else if (branch) {
      aheadCount = yield* computeAheadCountAgainstBase(cwd, branch).pipe(
        Effect.orElseSucceed(() => 0),
      );
    }

    const defaultBranch = yield* resolveDefaultBranchName(cwd, "origin");
    const isDefaultBranch =
      branch !== null &&
      (branch === defaultBranch ||
        (defaultBranch === null && (branch === "main" || branch === "master")));
    const aheadOfDefaultCount =
      branch && !isDefaultBranch
        ? upstreamRef === null
          ? aheadCount
          : yield* computeAheadCountAgainstBase(cwd, branch).pipe(Effect.orElseSucceed(() => 0))
        : 0;

    return {
      isRepo: true,
      isDefaultBranch,
      branch,
      upstreamRef,
      hasUpstream: upstreamRef !== null,
      aheadCount,
      behindCount,
      aheadOfDefaultCount,
    };
  });

  const readBranchRecency = Effect.fn("readBranchRecency")(function* (cwd: string) {
    const branchRecency = yield* executeGit(
      "GitVcsDriver.readBranchRecency",
      cwd,
      [
        "for-each-ref",
        "--format=%(refname:short)%09%(committerdate:unix)",
        "refs/heads",
        "refs/remotes",
      ],
      {
        timeoutMs: 15_000,
        allowNonZeroExit: true,
      },
    );

    const branchLastCommit = new Map<string, number>();
    if (branchRecency.exitCode !== 0) {
      return branchLastCommit;
    }

    for (const line of branchRecency.stdout.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      const [name, lastCommitRaw] = line.split("\t");
      if (!name) {
        continue;
      }
      const lastCommit = Number.parseInt(lastCommitRaw ?? "0", 10);
      branchLastCommit.set(name, Number.isFinite(lastCommit) ? lastCommit : 0);
    }

    return branchLastCommit;
  });

  const readStatusDetailsLocal = Effect.fn("readStatusDetailsLocal")(function* (cwd: string) {
    let statusResult = yield* runStatusPorcelain(cwd);

    if (statusResult === null) {
      return NON_REPOSITORY_STATUS_DETAILS;
    }

    let repairNote = "";
    if (
      statusResult.exitCode !== 0 &&
      isCorruptHeadGitStderr(statusResult.stderr) &&
      !headRepairFailed.has(cwd)
    ) {
      const repair = yield* repairCorruptHead(cwd).pipe(
        Effect.catchTags({
          GitCommandError: (error) =>
            Effect.succeed({ repaired: false, detail: error.detail } as const),
        }),
      );
      yield* Effect.logWarning("git HEAD repair", { cwd, ...repair });
      if (repair.repaired) {
        statusResult = (yield* runStatusPorcelain(cwd)) ?? statusResult;
      } else {
        headRepairFailed.add(cwd);
        repairNote = ` Could not repair HEAD: ${repair.detail}.`;
      }
    }

    if (statusResult.exitCode !== 0) {
      if (isNonRepositoryGitStderr(statusResult.stderr)) {
        return NON_REPOSITORY_STATUS_DETAILS;
      }
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.statusDetails.status",
          cwd,
          args: ["status", "--porcelain=2", "--branch"],
        }),
        detail: `${withGitFailureDetail("Git status failed.", statusResult)}${repairNote}`,
        exitCode: statusResult.exitCode,
        stdoutLength: statusResult.stdout.length,
        stderrLength: statusResult.stderr.length,
      });
    }
    headRepairFailed.delete(cwd);

    const [unstagedNumstatStdout, stagedNumstatStdout, defaultRefResult, hasPrimaryRemote] =
      yield* Effect.all(
        [
          runGitStdout("GitVcsDriver.statusDetails.unstagedNumstat", cwd, ["diff", "--numstat"]),
          runGitStdout("GitVcsDriver.statusDetails.stagedNumstat", cwd, [
            "diff",
            "--cached",
            "--numstat",
          ]),
          executeGit(
            "GitVcsDriver.statusDetails.defaultRef",
            cwd,
            ["symbolic-ref", "refs/remotes/origin/HEAD"],
            {
              allowNonZeroExit: true,
            },
          ),
          originRemoteExists(cwd).pipe(Effect.orElseSucceed(() => false)),
        ],
        { concurrency: "unbounded" },
      );
    const statusStdout = statusResult.stdout;
    const defaultBranch =
      defaultRefResult.exitCode === 0
        ? defaultRefResult.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
        : null;

    let refName: string | null = null;
    let upstreamRef: string | null = null;
    let aheadCount = 0;
    let behindCount = 0;
    let aheadOfDefaultCount = 0;
    let hasWorkingTreeChanges = false;
    const changedFilesWithoutNumstat = new Set<string>();

    for (const line of statusStdout.split(/\r?\n/g)) {
      if (line.startsWith("# branch.head ")) {
        const value = line.slice("# branch.head ".length).trim();
        refName = value.startsWith("(") ? null : value;
        continue;
      }
      if (line.startsWith("# branch.upstream ")) {
        const value = line.slice("# branch.upstream ".length).trim();
        upstreamRef = value.length > 0 ? value : null;
        continue;
      }
      if (line.startsWith("# branch.ab ")) {
        const value = line.slice("# branch.ab ".length).trim();
        const parsed = parseBranchAb(value);
        aheadCount = parsed.ahead;
        behindCount = parsed.behind;
        continue;
      }
      if (line.trim().length > 0 && !line.startsWith("#")) {
        hasWorkingTreeChanges = true;
        const pathValue = parsePorcelainPath(line);
        if (pathValue) changedFilesWithoutNumstat.add(pathValue);
      }
    }

    const fallbackAheadCount =
      !upstreamRef && refName
        ? yield* computeAheadCountAgainstBase(cwd, refName).pipe(Effect.orElseSucceed(() => 0))
        : null;

    if (fallbackAheadCount !== null) {
      aheadCount = fallbackAheadCount;
      behindCount = 0;
    }

    const isDefaultBranch =
      refName !== null &&
      (refName === defaultBranch ||
        (defaultBranch === null && (refName === "main" || refName === "master")));
    if (refName && !isDefaultBranch) {
      aheadOfDefaultCount =
        fallbackAheadCount !== null
          ? fallbackAheadCount
          : yield* computeAheadCountAgainstBase(cwd, refName).pipe(Effect.orElseSucceed(() => 0));
    }

    const stagedEntries = parseNumstatEntries(stagedNumstatStdout);
    const unstagedEntries = parseNumstatEntries(unstagedNumstatStdout);
    const fileStatMap = new Map<string, { insertions: number; deletions: number }>();
    for (const entry of [...stagedEntries, ...unstagedEntries]) {
      const existing = fileStatMap.get(entry.path) ?? { insertions: 0, deletions: 0 };
      existing.insertions += entry.insertions;
      existing.deletions += entry.deletions;
      fileStatMap.set(entry.path, existing);
    }

    let insertions = 0;
    let deletions = 0;
    const files = Array.from(fileStatMap.entries())
      .map(([filePath, stat]) => {
        insertions += stat.insertions;
        deletions += stat.deletions;
        return { path: filePath, insertions: stat.insertions, deletions: stat.deletions };
      })
      .toSorted((a, b) => a.path.localeCompare(b.path));

    for (const filePath of changedFilesWithoutNumstat) {
      if (fileStatMap.has(filePath)) continue;
      files.push({ path: filePath, insertions: 0, deletions: 0 });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));

    return {
      isRepo: true,
      hasOriginRemote: hasPrimaryRemote,
      isDefaultBranch,
      branch: refName,
      upstreamRef,
      hasWorkingTreeChanges,
      workingTree: {
        files,
        insertions,
        deletions,
      },
      hasUpstream: upstreamRef !== null,
      aheadCount,
      behindCount,
      aheadOfDefaultCount,
    };
  });

  const statusDetailsLocal: GitVcsDriver.GitVcsDriver["Service"]["statusDetailsLocal"] = Effect.fn(
    "statusDetailsLocal",
  )(function* (cwd) {
    return yield* readStatusDetailsLocal(cwd);
  });

  const statusDetails: GitVcsDriver.GitVcsDriver["Service"]["statusDetails"] = Effect.fn(
    "statusDetails",
  )(function* (cwd) {
    yield* refreshStatusUpstreamIfStale(cwd).pipe(
      Effect.catchTags({
        GitCommandError: (error) =>
          isMissingGitCwdError(error) ? Effect.void : Effect.fail(error),
      }),
      Effect.ignoreCause({ log: true }),
    );
    return yield* readStatusDetailsLocal(cwd);
  });

  const statusDetailsRemote: GitVcsDriver.GitVcsDriver["Service"]["statusDetailsRemote"] =
    Effect.fn("statusDetailsRemote")(function* (cwd, options) {
      if (options?.refreshUpstream !== false) {
        yield* refreshStatusUpstreamIfStale(cwd).pipe(
          Effect.catchTags({
            GitCommandError: (error) =>
              isMissingGitCwdError(error) ? Effect.void : Effect.fail(error),
          }),
          Effect.ignoreCause({ log: true }),
        );
      }
      return yield* readStatusDetailsRemote(cwd);
    });

  const status: GitVcsDriver.GitVcsDriver["Service"]["status"] = (input) =>
    statusDetails(input.cwd).pipe(
      Effect.map((details) => ({
        isRepo: details.isRepo,
        hasPrimaryRemote: details.hasOriginRemote,
        isDefaultRef: details.isDefaultBranch,
        refName: details.branch,
        hasWorkingTreeChanges: details.hasWorkingTreeChanges,
        workingTree: details.workingTree,
        hasUpstream: details.hasUpstream,
        aheadCount: details.aheadCount,
        behindCount: details.behindCount,
        aheadOfDefaultCount: details.aheadOfDefaultCount,
        pr: null,
      })),
    );

  /**
   * Staging is the first write of every commit, push and pull-request run, and
   * it has no progress channel to carry git's output. Without git's own reason
   * a full disk or a stale `index.lock` reaches the board as a bare "non-zero
   * status" — unreadable, and identical every time it recurs.
   */
  const runCommitContextGit = Effect.fn("runCommitContextGit")(function* (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ) {
    const result = yield* executeGit(operation, cwd, args, {
      ...options,
      allowNonZeroExit: true,
    });
    if (result.exitCode !== 0) {
      return yield* new GitCommandError({
        ...gitCommandContext({ operation, cwd, args }),
        detail: withGitFailureDetail("Git command exited with a non-zero status.", result),
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        stdoutLength: result.stdout.length,
        stderrLength: result.stderr.length,
      });
    }
    return result;
  });

  const prepareCommitContext: GitVcsDriver.GitVcsDriver["Service"]["prepareCommitContext"] =
    Effect.fn("prepareCommitContext")(function* (cwd, filePaths) {
      if (filePaths && filePaths.length > 0) {
        yield* runGit("GitVcsDriver.prepareCommitContext.reset", cwd, ["reset"]).pipe(
          Effect.catchTags({
            GitCommandError: () => Effect.void,
          }),
        );
        yield* runCommitContextGit("GitVcsDriver.prepareCommitContext.addSelected", cwd, [
          "--literal-pathspecs",
          "add",
          "-A",
          "--",
          ...filePaths,
        ]);
      } else {
        yield* runCommitContextGit("GitVcsDriver.prepareCommitContext.addAll", cwd, ["add", "-A"]);
      }

      const stagedSummary = yield* runCommitContextGit(
        "GitVcsDriver.prepareCommitContext.stagedSummary",
        cwd,
        ["diff", "--cached", "--name-status"],
      ).pipe(Effect.map((result) => result.stdout.trim()));
      if (stagedSummary.length === 0) {
        return null;
      }

      const stagedPatch = yield* runCommitContextGit(
        "GitVcsDriver.prepareCommitContext.stagedPatch",
        cwd,
        ["diff", "--no-ext-diff", "--cached", "--patch", "--minimal"],
        {
          maxOutputBytes: PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES,
          appendTruncationMarker: true,
        },
      ).pipe(
        Effect.map((result) =>
          result.stdoutTruncated ? `${result.stdout}${OUTPUT_TRUNCATED_MARKER}` : result.stdout,
        ),
      );

      return {
        stagedSummary,
        stagedPatch,
      };
    });

  const commit: GitVcsDriver.GitVcsDriver["Service"]["commit"] = Effect.fn("commit")(function* (
    cwd,
    subject,
    body,
    options?: GitVcsDriver.GitCommitOptions,
  ) {
    const args = [...commitIdentityArgs(options?.identity), "commit", "-m", subject];
    const trimmedBody = body.trim();
    if (trimmedBody.length > 0) {
      args.push("-m", trimmedBody);
    }
    const progress =
      options?.progress?.onOutputLine === undefined
        ? options?.progress
        : {
            ...options.progress,
            onStdoutLine: (line: string) =>
              options.progress?.onOutputLine?.({ stream: "stdout", text: line }) ?? Effect.void,
            onStderrLine: (line: string) =>
              options.progress?.onOutputLine?.({ stream: "stderr", text: line }) ?? Effect.void,
          };
    yield* executeGit("GitVcsDriver.commit.commit", cwd, args, {
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(progress ? { progress } : {}),
    }).pipe(Effect.asVoid);
    const commitSha = yield* runGitStdout("GitVcsDriver.commit.revParseHead", cwd, [
      "rev-parse",
      "HEAD",
    ]).pipe(Effect.map((stdout) => stdout.trim()));

    return { commitSha };
  });

  const pushCurrentBranch: GitVcsDriver.GitVcsDriver["Service"]["pushCurrentBranch"] = Effect.fn(
    "pushCurrentBranch",
  )(function* (cwd, fallbackBranch, options) {
    const details = yield* statusDetails(cwd);
    const branch = details.branch ?? fallbackBranch;
    if (!branch) {
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.pushCurrentBranch",
          cwd,
          args: ["push"],
        }),
        detail: "Cannot push from detached HEAD.",
      });
    }

    const requestedRemoteName = options?.remoteName?.trim() || null;
    if (requestedRemoteName) {
      const publishBranch = yield* resolvePublishBranchName(cwd, branch);
      yield* runGit("GitVcsDriver.pushCurrentBranch.pushWithRequestedRemote", cwd, [
        "push",
        "-u",
        requestedRemoteName,
        `HEAD:refs/heads/${publishBranch}`,
      ]);
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: `${requestedRemoteName}/${publishBranch}`,
        setUpstream: true,
      };
    }

    const hasNoLocalDelta = details.aheadCount === 0 && details.behindCount === 0;
    if (hasNoLocalDelta) {
      if (details.hasUpstream) {
        return {
          status: "skipped_up_to_date" as const,
          branch,
          ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
        };
      }

      const comparableBaseBranch = yield* resolveBaseBranchForNoUpstream(cwd, branch).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (comparableBaseBranch) {
        const publishRemoteName = yield* resolvePushRemoteName(cwd, branch).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (!publishRemoteName) {
          return {
            status: "skipped_up_to_date" as const,
            branch,
          };
        }

        const hasRemoteBranch = yield* remoteBranchExists(cwd, publishRemoteName, branch).pipe(
          Effect.orElseSucceed(() => false),
        );
        if (hasRemoteBranch) {
          return {
            status: "skipped_up_to_date" as const,
            branch,
          };
        }
      }
    }

    if (!details.hasUpstream) {
      const publishRemoteName = yield* resolvePushRemoteName(cwd, branch);
      if (!publishRemoteName) {
        return yield* new GitCommandError({
          ...gitCommandContext({
            operation: "GitVcsDriver.pushCurrentBranch",
            cwd,
            args: ["push"],
          }),
          detail: "Cannot push because no git remote is configured for this repository.",
        });
      }
      let publishBranch = yield* resolvePublishBranchName(cwd, branch);
      const matchingRemoteBranches = yield* listMatchingRemoteBranches(
        cwd,
        publishRemoteName,
        publishBranch,
      );
      if (matchingRemoteBranches.has(publishBranch)) {
        yield* runGit("GitVcsDriver.pushCurrentBranch.fetchPublishBranch", cwd, [
          "fetch",
          "--quiet",
          "--no-tags",
          publishRemoteName,
          `+refs/heads/${publishBranch}:refs/remotes/${publishRemoteName}/${publishBranch}`,
        ]);
        const remoteIsAncestor = yield* executeGit(
          "GitVcsDriver.pushCurrentBranch.remoteIsAncestor",
          cwd,
          [
            "merge-base",
            "--is-ancestor",
            `refs/remotes/${publishRemoteName}/${publishBranch}`,
            "HEAD",
          ],
          { allowNonZeroExit: true },
        );
        if (remoteIsAncestor.exitCode !== 0) {
          const availableBranch = resolveAvailableRemoteBranchName(
            publishBranch,
            matchingRemoteBranches,
          );
          if (!availableBranch) {
            return yield* new GitCommandError({
              ...gitCommandContext({
                operation: "GitVcsDriver.pushCurrentBranch",
                cwd,
                args: ["push", "-u", publishRemoteName],
              }),
              detail:
                `Remote branch '${publishRemoteName}/${publishBranch}' has different history, ` +
                "and no unused suffixed branch name is available. Rename the local branch and retry.",
            });
          }
          publishBranch = availableBranch;
        }
      }
      yield* runGit("GitVcsDriver.pushCurrentBranch.pushWithUpstream", cwd, [
        "push",
        "-u",
        publishRemoteName,
        `HEAD:refs/heads/${publishBranch}`,
      ]);
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: `${publishRemoteName}/${publishBranch}`,
        setUpstream: true,
      };
    }

    const currentUpstream = yield* resolveCurrentUpstream(cwd).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (currentUpstream) {
      yield* runGit("GitVcsDriver.pushCurrentBranch.pushUpstream", cwd, [
        "push",
        currentUpstream.remoteName,
        `HEAD:refs/heads/${currentUpstream.branchName}`,
      ]);
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: currentUpstream.upstreamRef,
        setUpstream: false,
      };
    }

    yield* runGit("GitVcsDriver.pushCurrentBranch.push", cwd, ["push"]);
    return {
      status: "pushed" as const,
      branch,
      ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
      setUpstream: false,
    };
  });

  const pullCurrentBranch: GitVcsDriver.GitVcsDriver["Service"]["pullCurrentBranch"] = Effect.fn(
    "pullCurrentBranch",
  )(function* (cwd) {
    const details = yield* statusDetails(cwd);
    const refName = details.branch;
    if (!refName) {
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.pullCurrentBranch",
          cwd,
          args: ["pull", "--ff-only"],
        }),
        detail: "Cannot pull from detached HEAD.",
      });
    }
    if (!details.hasUpstream) {
      return yield* new GitCommandError({
        ...gitCommandContext({
          operation: "GitVcsDriver.pullCurrentBranch",
          cwd,
          args: ["pull", "--ff-only"],
        }),
        detail: "Current branch has no upstream configured. Push with upstream first.",
      });
    }
    const beforeSha = yield* runGitStdout(
      "GitVcsDriver.pullCurrentBranch.beforeSha",
      cwd,
      ["rev-parse", "HEAD"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    yield* executeGit("GitVcsDriver.pullCurrentBranch.pull", cwd, ["pull", "--ff-only"], {
      timeoutMs: 30_000,
      fallbackErrorDetail: "git pull failed",
    });
    const afterSha = yield* runGitStdout(
      "GitVcsDriver.pullCurrentBranch.afterSha",
      cwd,
      ["rev-parse", "HEAD"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));

    const refreshed = yield* statusDetails(cwd);
    return {
      status: beforeSha.length > 0 && beforeSha === afterSha ? "skipped_up_to_date" : "pulled",
      refName,
      upstreamRef: refreshed.upstreamRef,
    };
  });

  const readRangeContext: GitVcsDriver.GitVcsDriver["Service"]["readRangeContext"] = Effect.fn(
    "readRangeContext",
  )(function* (cwd, baseRef) {
    const range = `${baseRef}..HEAD`;
    const [commitSummary, diffSummary, diffPatch] = yield* Effect.all(
      [
        runGitStdoutWithOptions(
          "GitVcsDriver.readRangeContext.log",
          cwd,
          ["log", "--oneline", range],
          {
            maxOutputBytes: RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES,
            appendTruncationMarker: true,
          },
        ),
        runGitStdoutWithOptions(
          "GitVcsDriver.readRangeContext.diffStat",
          cwd,
          ["diff", "--stat", range],
          {
            maxOutputBytes: RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES,
            appendTruncationMarker: true,
          },
        ),
        runGitStdoutWithOptions(
          "GitVcsDriver.readRangeContext.diffPatch",
          cwd,
          ["diff", "--no-ext-diff", "--patch", "--minimal", range],
          {
            maxOutputBytes: RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES,
            appendTruncationMarker: true,
          },
        ),
      ],
      { concurrency: "unbounded" },
    );

    return {
      commitSummary,
      diffSummary,
      diffPatch,
    };
  });

  const readUntrackedReviewDiffs = Effect.fn("readUntrackedReviewDiffs")(function* (cwd: string) {
    const untrackedResult = yield* executeGit(
      "GitVcsDriver.readUntrackedReviewDiffs.list",
      cwd,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      {
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    );
    const untrackedPaths = splitNullSeparatedGitStdoutPaths(untrackedResult);
    if (untrackedPaths.length === 0) {
      return { diff: "", truncated: untrackedResult.stdoutTruncated };
    }

    const diffs = yield* Effect.forEach(
      untrackedPaths,
      (relativePath) =>
        executeGit(
          "GitVcsDriver.readUntrackedReviewDiffs.diff",
          cwd,
          ["diff", "--no-index", "--patch", "--minimal", "--", "/dev/null", relativePath],
          {
            allowNonZeroExit: true,
            maxOutputBytes: REVIEW_UNTRACKED_DIFF_MAX_OUTPUT_BYTES,
            appendTruncationMarker: true,
          },
        ),
      { concurrency: 4 },
    );

    return {
      diff: Arr.filterMap(diffs, (result) =>
        result.stdout.trim().length > 0 ? Result.succeed(result.stdout) : Result.failVoid,
      ).join("\n"),
      truncated: untrackedResult.stdoutTruncated || diffs.some((result) => result.stdoutTruncated),
    };
  });

  const getReviewDiffPreview = Effect.fn("getReviewDiffPreview")(function* (
    input: ReviewDiffPreviewInput,
  ) {
    const details = yield* statusDetailsLocal(input.cwd);
    if (!details.isRepo) {
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: [],
      };
    }

    const branch = details.branch;
    const baseRef =
      input.baseRef ??
      (branch
        ? yield* resolveBaseBranchForNoUpstream(input.cwd, branch).pipe(
            Effect.orElseSucceed(() => null),
          )
        : null);

    const dirtyTrackedResult = yield* executeGit(
      "GitVcsDriver.getReviewDiffPreview.dirtyTracked",
      input.cwd,
      [
        "diff",
        "--patch",
        "--minimal",
        ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
        "HEAD",
        "--",
      ],
      {
        maxOutputBytes: REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    ).pipe(
      Effect.orElseSucceed(() => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      })),
    );
    const dirtyUntracked = yield* readUntrackedReviewDiffs(input.cwd).pipe(
      Effect.orElseSucceed(() => ({ diff: "", truncated: false })),
    );
    const dirtyDiff = [dirtyTrackedResult.stdout.trimEnd(), dirtyUntracked.diff.trimEnd()]
      .filter((diff) => diff.length > 0)
      .join("\n");

    const baseResult =
      baseRef && branch
        ? yield* executeGit(
            "GitVcsDriver.getReviewDiffPreview.base",
            input.cwd,
            [
              "diff",
              "--patch",
              "--minimal",
              ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
              `${baseRef}...HEAD`,
            ],
            {
              maxOutputBytes: REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES,
              appendTruncationMarker: true,
            },
          ).pipe(
            Effect.orElseSucceed(() => ({
              exitCode: 0,
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            })),
          )
        : null;
    const baseDiff = baseResult?.stdout ?? "";
    const hashDiff = (diff: string) =>
      crypto.digest("SHA-256", new TextEncoder().encode(diff)).pipe(
        Effect.map(Encoding.encodeHex),
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "GitVcsDriver.getReviewDiffPreview.hash",
              command: "crypto.digest SHA-256",
              cwd: input.cwd,
              detail: "Failed to hash review diff.",
              cause,
            }),
        ),
      );
    const [dirtyDiffHash, baseDiffHash] = yield* Effect.all([
      hashDiff(dirtyDiff),
      hashDiff(baseDiff),
    ]);

    const sources: ReviewDiffPreviewSource[] = [
      {
        id: "working-tree",
        kind: "working-tree",
        title: "Dirty worktree",
        baseRef: "HEAD",
        headRef: null,
        diff: dirtyDiff,
        diffHash: dirtyDiffHash,
        truncated: dirtyTrackedResult.stdoutTruncated || dirtyUntracked.truncated,
      },
      {
        id: "branch-range",
        kind: "branch-range",
        title: baseRef ? `Against ${baseRef}` : "Against base branch",
        baseRef,
        headRef: branch ?? "HEAD",
        diff: baseDiff,
        diffHash: baseDiffHash,
        truncated: baseResult?.stdoutTruncated ?? false,
      },
    ];

    return {
      cwd: input.cwd,
      generatedAt: yield* DateTime.now,
      sources,
    };
  });

  const readConfigValue: GitVcsDriver.GitVcsDriver["Service"]["readConfigValue"] = (cwd, key) =>
    runGitStdout("GitVcsDriver.readConfigValue", cwd, ["config", "--get", key], true).pipe(
      Effect.map((stdout) => stdout.trim()),
      Effect.map((trimmed) => (trimmed.length > 0 ? trimmed : null)),
    );

  const listRefs: GitVcsDriver.GitVcsDriver["Service"]["listRefs"] = Effect.fn("listRefs")(
    function* (input) {
      const branchRecencyPromise = readBranchRecency(input.cwd).pipe(
        Effect.orElseSucceed(() => new Map<string, number>()),
      );
      const localBranchResult = yield* executeGitWithStableDiagnostics(
        "GitVcsDriver.listRefs.branchNoColor",
        input.cwd,
        ["branch", "--no-color", "--no-column"],
        {
          timeoutMs: 10_000,
          allowNonZeroExit: true,
        },
      ).pipe(
        Effect.catchTags({
          GitCommandError: (error) =>
            isMissingGitCwdError(error)
              ? Effect.succeed({
                  exitCode: ChildProcessSpawner.ExitCode(128),
                  stdout: "",
                  stderr: "fatal: not a git repository",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                })
              : Effect.fail(error),
        }),
      );

      if (localBranchResult.exitCode !== 0) {
        const stderr = localBranchResult.stderr.trim();
        if (isNonRepositoryGitStderr(stderr)) {
          return {
            refs: [],
            isRepo: false,
            hasPrimaryRemote: false,
            nextCursor: null,
            totalCount: 0,
          };
        }
        return yield* new GitCommandError({
          ...gitCommandContext({
            operation: "GitVcsDriver.listRefs",
            cwd: input.cwd,
            args: ["branch", "--no-color", "--no-column"],
          }),
          detail: "Git branch listing failed.",
          exitCode: localBranchResult.exitCode,
          stdoutLength: localBranchResult.stdout.length,
          stderrLength: localBranchResult.stderr.length,
        });
      }

      const remoteBranchResultEffect = executeGit(
        "GitVcsDriver.listRefs.remoteBranches",
        input.cwd,
        ["branch", "--no-color", "--no-column", "--remotes"],
        {
          timeoutMs: 10_000,
          allowNonZeroExit: true,
        },
      ).pipe(
        Effect.catchTags({
          GitCommandError: (error) =>
            Effect.logWarning(
              "Git remote ref lookup failed; falling back to an empty remote ref list.",
              {
                operation: error.operation,
                command: error.command,
                cwd: error.cwd,
                detail: error.detail,
                cause: error,
              },
            ).pipe(
              Effect.as({
                exitCode: ChildProcessSpawner.ExitCode(1),
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              } satisfies GitVcsDriver.ExecuteGitResult),
            ),
        }),
      );

      const remoteNamesResultEffect = executeGit(
        "GitVcsDriver.listRefs.remoteNames",
        input.cwd,
        ["remote"],
        {
          timeoutMs: 5_000,
          allowNonZeroExit: true,
        },
      ).pipe(
        Effect.catchTags({
          GitCommandError: (error) =>
            Effect.logWarning(
              "Git remote name lookup failed; falling back to an empty remote name list.",
              {
                operation: error.operation,
                command: error.command,
                cwd: error.cwd,
                detail: error.detail,
                cause: error,
              },
            ).pipe(
              Effect.as({
                exitCode: ChildProcessSpawner.ExitCode(1),
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              } satisfies GitVcsDriver.ExecuteGitResult),
            ),
        }),
      );

      const [defaultRef, worktreeList, remoteBranchResult, remoteNamesResult, branchLastCommit] =
        yield* Effect.all(
          [
            executeGit(
              "GitVcsDriver.listRefs.defaultRef",
              input.cwd,
              ["symbolic-ref", "refs/remotes/origin/HEAD"],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ),
            executeGit(
              "GitVcsDriver.listRefs.worktreeList",
              input.cwd,
              ["worktree", "list", "--porcelain"],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ),
            remoteBranchResultEffect,
            remoteNamesResultEffect,
            branchRecencyPromise,
          ],
          { concurrency: "unbounded" },
        );

      const remoteNames =
        remoteNamesResult.exitCode === 0 ? parseRemoteNames(remoteNamesResult.stdout) : [];
      if (remoteBranchResult.exitCode !== 0 && remoteBranchResult.stderr.trim().length > 0) {
        yield* Effect.logWarning(
          `GitVcsDriver.listRefs: remote refName lookup returned code ${remoteBranchResult.exitCode} for ${input.cwd}: ${remoteBranchResult.stderr.trim()}. Falling back to an empty remote refName list.`,
        );
      }
      if (remoteNamesResult.exitCode !== 0 && remoteNamesResult.stderr.trim().length > 0) {
        yield* Effect.logWarning(
          `GitVcsDriver.listRefs: remote name lookup returned code ${remoteNamesResult.exitCode} for ${input.cwd}: ${remoteNamesResult.stderr.trim()}. Falling back to an empty remote name list.`,
        );
      }

      const defaultBranch =
        defaultRef.exitCode === 0
          ? defaultRef.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
          : null;

      const worktreeMap = new Map<string, string>();
      if (worktreeList.exitCode === 0) {
        let currentPath: string | null = null;
        for (const line of worktreeList.stdout.split("\n")) {
          if (line.startsWith("worktree ")) {
            const candidatePath = line.slice("worktree ".length);
            const exists = yield* fileSystem.stat(candidatePath).pipe(
              Effect.map(() => true),
              Effect.orElseSucceed(() => false),
            );
            currentPath = exists ? candidatePath : null;
          } else if (line.startsWith("branch refs/heads/") && currentPath) {
            worktreeMap.set(line.slice("branch refs/heads/".length), currentPath);
          } else if (line === "") {
            currentPath = null;
          }
        }
      }

      const localBranches = Arr.filterMap(localBranchResult.stdout.split("\n"), (line) => {
        const refName = parseBranchLine(line);
        return refName === null
          ? Result.failVoid
          : Result.succeed({
              name: refName.name,
              current: refName.current,
              isRemote: false,
              isDefault: refName.name === defaultBranch,
              worktreePath: worktreeMap.get(refName.name) ?? null,
            });
      }).toSorted((a, b) => {
        const aPriority = a.current ? 0 : a.isDefault ? 1 : 2;
        const bPriority = b.current ? 0 : b.isDefault ? 1 : 2;
        if (aPriority !== bPriority) return aPriority - bPriority;

        const aLastCommit = branchLastCommit.get(a.name) ?? 0;
        const bLastCommit = branchLastCommit.get(b.name) ?? 0;
        if (aLastCommit !== bLastCommit) return bLastCommit - aLastCommit;
        return a.name.localeCompare(b.name);
      });

      const remoteBranches =
        remoteBranchResult.exitCode === 0
          ? Arr.filterMap(remoteBranchResult.stdout.split("\n"), (line) => {
              const refName = parseBranchLine(line);
              if (refName === null) {
                return Result.failVoid;
              }
              const parsedRemoteRef = parseRemoteRefWithRemoteNames(refName.name, remoteNames);
              const remoteBranch: {
                name: string;
                current: boolean;
                isRemote: boolean;
                remoteName?: string;
                isDefault: boolean;
                worktreePath: string | null;
              } = {
                name: refName.name,
                current: false,
                isRemote: true,
                isDefault: false,
                worktreePath: null,
              };
              if (parsedRemoteRef) {
                remoteBranch.remoteName = parsedRemoteRef.remoteName;
              }
              return Result.succeed(remoteBranch);
            }).toSorted((a, b) => {
              const aLastCommit = branchLastCommit.get(a.name) ?? 0;
              const bLastCommit = branchLastCommit.get(b.name) ?? 0;
              if (aLastCommit !== bLastCommit) return bLastCommit - aLastCommit;
              return a.name.localeCompare(b.name);
            })
          : [];

      const allBranches = input.includeMatchingRemoteRefs
        ? [...localBranches, ...remoteBranches]
        : dedupeRemoteBranchesWithLocalMatches([...localBranches, ...remoteBranches]);
      const branchesForKind =
        input.refKind === "local"
          ? allBranches.filter((ref) => !ref.isRemote)
          : input.refKind === "remote"
            ? allBranches.filter((ref) => ref.isRemote)
            : allBranches;
      const refs = paginateBranches({
        refs: filterBranchesForListQuery(branchesForKind, input.query),
        cursor: input.cursor,
        limit: input.limit,
      });

      return {
        refs: [...refs.refs],
        isRepo: true,
        hasPrimaryRemote: remoteNames.includes("origin"),
        nextCursor: refs.nextCursor,
        totalCount: refs.totalCount,
      };
    },
  );

  // Rift snapshots a repository via copy-on-write reflinks, which the source
  // filesystem must support. `rift init` fails on filesystems without reflink
  // support (ext4, most overlay/NFS mounts). Detect exactly that condition so we
  // can degrade to a plain git worktree instead of surfacing a raw tool error.
  const isReflinkUnsupportedRiftError = (error: GitCommandError): boolean =>
    error.command === "rift" && /copy-on-write|reflink/i.test(error.detail ?? "");

  const createWorktree: GitVcsDriver.GitVcsDriver["Service"]["createWorktree"] = Effect.fn(
    "createWorktree",
  )(function* (input) {
    const targetBranch = input.newRefName ?? input.refName;
    const sanitizedBranch = targetBranch.replace(/\//g, "-");
    const requestedPath = input.path;

    // A source checkout whose HEAD does not resolve is copied, corruption and
    // all, into every workspace snapshotted from it — so the agent's own shell
    // gets `fatal: bad object HEAD` and cannot commit, and the board cannot open
    // its PR. Healing on read (statusDetails) only fixes what the server reads.
    // No-op when HEAD is fine, which is the normal case.
    yield* healHead(input.cwd);

    // Keep the registered source's origin ref current before Rift snapshots its
    // repository metadata. The new workspace is then placed on the requested
    // ref; normal new-thread callers pass the freshly resolved origin base SHA.
    // Best-effort: a repo without an `origin` remote or without that branch
    // should still get a worktree (the caller resolves the actual starting ref
    // separately), so tolerate a non-zero exit here instead of hard-failing the
    // whole operation on the refresh.
    //
    // The branch is the caller's, not a literal `main`: a repo on `master` or
    // `develop` used to get no refresh here at all.
    const refreshBranch = input.baseRefName?.split("/").pop()?.trim() || "main";
    yield* executeGit(
      "GitVcsDriver.createWorktree.fetchOriginBase",
      input.cwd,
      [
        "fetch",
        "--quiet",
        "origin",
        `+refs/heads/${refreshBranch}:refs/remotes/origin/${refreshBranch}`,
      ],
      { allowNonZeroExit: true },
    );

    // `origin/HEAD` is written at clone time and never again, so every later
    // "which branch is default" read answers with whatever was true then.
    yield* executeGit(
      "GitVcsDriver.createWorktree.refreshOriginHead",
      input.cwd,
      ["remote", "set-head", "origin", "--auto"],
      { allowNonZeroExit: true },
    );

    // Where the workspace lands: for Rift this is `--into <dir> --name <name>`;
    // the git-worktree fallback creates the same target path directly.
    //
    // Always absolute. Callers that own a thread pass a thread-scoped `path`
    // (see `buildThreadWorktreePath`); callers without one (PR worktrees, the
    // doctor) fall back to the branch name *inside the workspace root*, never
    // to a bare relative name — a relative target is how `rift create` ends up
    // resolving against `/` and dying with "mkdir: cannot create directory
    // '/<branch>': Permission denied".
    const worktreeTarget = path.resolve(
      requestedPath ??
        path.join(
          resolveWorktreeRoot({ path, projectCwd: input.cwd }),
          sanitizeWorktreeSegment(sanitizedBranch),
        ),
    );

    const configureBaseRef = Effect.fn("GitVcsDriver.createWorktree.configureBaseRef")(function* (
      worktreePath: string,
    ) {
      if (input.newRefName && input.baseRefName) {
        const remoteNames = yield* listRemoteNames(input.cwd).pipe(Effect.orElseSucceed(() => []));
        const parsedBaseRef = parseRemoteRefWithRemoteNames(
          input.baseRefName,
          remoteNames.toSorted((left, right) => right.length - left.length),
        );
        const baseBranch = parsedBaseRef?.branchName ?? input.baseRefName;
        yield* runGit("GitVcsDriver.createWorktree.configureBaseRef", worktreePath, [
          "config",
          `branch.${input.newRefName}.gh-merge-base`,
          baseBranch,
        ]);
      }
    });

    let initResult = yield* Effect.result(
      executeRift("GitVcsDriver.createWorktree.initRift", input.cwd, ["init", "--here"]),
    );

    // Stale marker first: clearing `.rift` and retrying init is cheaper and
    // keeps Rift as the workspace backend. Only after that (or for other
    // failures) do we consider the reflink → git-worktree degrade path.
    if (Result.isFailure(initResult) && isStaleRiftMarkerOutput(initResult.failure.detail)) {
      const staleDetail = initResult.failure.detail;
      const markerPath = path.join(input.cwd, RIFT_MARKER_FILE_NAME);
      yield* fileSystem.remove(markerPath, { force: true }).pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "GitVcsDriver.createWorktree.clearStaleRiftMarker",
              command: "rift",
              cwd: input.cwd,
              detail: `Failed to clear stale Rift marker at ${markerPath} after: ${staleDetail}`,
              cause,
            }),
        ),
      );
      initResult = yield* Effect.result(
        executeRift("GitVcsDriver.createWorktree.initRift.afterStaleMarker", input.cwd, [
          "init",
          "--here",
        ]),
      );
    }

    if (Result.isFailure(initResult)) {
      const initError = initResult.failure;
      // Only reflink-unsupported failures are recoverable by degrading to a git
      // worktree. Any other Rift init failure (dirty checkout, missing binary,
      // ...) already carries an actionable reason — re-raise it unchanged.
      if (!isReflinkUnsupportedRiftError(initError)) {
        return yield* initError;
      }

      yield* Effect.logWarning(
        `Rift copy-on-write snapshot is unavailable for ${input.cwd} (${initError.detail}). ` +
          `Falling back to a plain git worktree at ${worktreeTarget}.`,
      );
      // A worktree whose directory was deleted outside git (a wiped /tmp, a
      // manual rm -rf, a container restart) leaves its registration behind in
      // .git/worktrees/. `git worktree add` at that path then fails against a
      // worktree that, on disk, no longer exists — bricking every relaunch
      // until someone runs this by hand. Pruning first is always safe: it
      // only drops entries whose directory is already gone.
      yield* executeGit(
        "GitVcsDriver.createWorktree.pruneStaleWorktrees",
        input.cwd,
        ["worktree", "prune"],
        { allowNonZeroExit: true },
      );
      yield* fileSystem.makeDirectory(path.dirname(worktreeTarget), { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "GitVcsDriver.createWorktree.gitWorktreeAdd",
              command: "git",
              cwd: input.cwd,
              detail: `Failed to create the parent directory for the git worktree at ${worktreeTarget}.`,
              cause,
            }),
        ),
      );
      // `git worktree add` refuses a target that already exists and is not
      // empty. Detect that up front and return an actionable error naming the
      // path instead of a raw "fatal: '<path>' already exists".
      const targetExists = yield* fileSystem.exists(worktreeTarget).pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "GitVcsDriver.createWorktree.gitWorktreeAdd",
              command: "git",
              cwd: input.cwd,
              detail: `Failed to check whether the git worktree target ${worktreeTarget} already exists.`,
              cause,
            }),
        ),
      );
      if (targetExists) {
        const targetEntries = yield* fileSystem
          .readDirectory(worktreeTarget, { recursive: false })
          .pipe(Effect.orElseSucceed(() => ["<not-a-directory>"] as ReadonlyArray<string>));
        if (targetEntries.length > 0) {
          return yield* new GitCommandError({
            operation: "GitVcsDriver.createWorktree.gitWorktreeAdd",
            command: "git",
            cwd: input.cwd,
            detail: `Cannot create a git worktree at ${worktreeTarget}: the path already exists and is not empty. Remove it or choose another workspace location, then retry.`,
          });
        }
      }
      // `git worktree add` creates the checkout AND places the requested branch
      // in one step, so no follow-up `git switch` is needed here.
      //
      // Deliberately no `--force`. Targets are thread-scoped, so a collision
      // here means two threads claimed one directory — a bug worth surfacing,
      // not something to overwrite. This is also the path most non-btrfs boxes
      // take, and it keeps the per-thread isolation the Rift path has: the
      // target is the same thread-scoped `worktreeTarget`.
      const addArgs = input.newRefName
        ? ["worktree", "add", "-B", input.newRefName, worktreeTarget, input.refName]
        : ["worktree", "add", worktreeTarget, input.refName];
      yield* executeGit("GitVcsDriver.createWorktree.gitWorktreeAdd", input.cwd, addArgs, {
        fallbackErrorDetail:
          `Failed to create a git worktree at ${worktreeTarget}. Rift is unavailable on this ` +
          "filesystem (no copy-on-write reflink support) and the git worktree fallback also failed.",
      });
      yield* configureBaseRef(worktreeTarget);
      return {
        worktree: {
          path: worktreeTarget,
          refName: targetBranch,
        },
      };
    }

    // `--into` is always passed and always absolute. Without it Rift resolves
    // the workspace against its own idea of a root — which is how CI ended up
    // trying to `mkdir /feature-pr-worktree` and failing on permissions.
    yield* fileSystem.makeDirectory(path.dirname(worktreeTarget), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation: "GitVcsDriver.createWorktree.createRift",
            command: "rift",
            cwd: input.cwd,
            detail: `Failed to create the workspace root ${path.dirname(worktreeTarget)}.`,
            cause,
          }),
      ),
    );
    const createArgs = [
      "create",
      "--name",
      path.basename(worktreeTarget),
      "--into",
      path.dirname(worktreeTarget),
    ];
    const worktreePath = yield* executeRift(
      "GitVcsDriver.createWorktree.createRift",
      input.cwd,
      createArgs,
      120_000,
    );
    if (worktreePath.length === 0) {
      return yield* new GitCommandError({
        operation: "GitVcsDriver.createWorktree.createRift",
        command: "rift",
        cwd: input.cwd,
        detail: "Rift did not report the created workspace path.",
      });
    }

    // The snapshot carries the source's git metadata, so a HEAD that broke
    // between the heal above and the copy lands here too — and `git switch`
    // against it dies before the session ever starts.
    yield* healHead(worktreePath);

    const switchArgs = input.newRefName
      ? ["switch", "-C", input.newRefName, input.refName]
      : ["switch", "--force", input.refName];
    const switched = yield* Effect.result(
      executeGit("GitVcsDriver.createWorktree.switchRef", worktreePath, switchArgs, {
        fallbackErrorDetail: "Failed to switch the Rift workspace to its requested starting ref.",
      }),
    );
    if (Result.isFailure(switched)) {
      // Rift sometimes snapshots before objects for a just-fetched origin SHA
      // are fully visible in the child, or leaves a workspace whose HEAD cannot
      // take `git switch -C`. Drop the bad workspace and use the same git
      // worktree path Active already trusts when Rift is unavailable — rather
      // than parking the card in Prompts with "no workspace of its own".
      const switchDetail = switched.failure.detail ?? switched.failure.message;
      yield* Effect.logWarning(
        `Rift workspace could not switch to ${input.refName} (${switchDetail}). ` +
          `Falling back to a plain git worktree at ${worktreeTarget}.`,
      );
      yield* fileSystem
        .remove(worktreePath, { recursive: true, force: true })
        .pipe(Effect.catch(() => Effect.void));
      yield* executeGit(
        "GitVcsDriver.createWorktree.pruneStaleWorktreesAfterSwitchFail",
        input.cwd,
        ["worktree", "prune"],
        { allowNonZeroExit: true },
      );
      const addArgs = input.newRefName
        ? ["worktree", "add", "-B", input.newRefName, worktreeTarget, input.refName]
        : ["worktree", "add", worktreeTarget, input.refName];
      yield* executeGit(
        "GitVcsDriver.createWorktree.gitWorktreeAddAfterSwitchFail",
        input.cwd,
        addArgs,
        {
          fallbackErrorDetail:
            `Failed to switch the Rift workspace to its requested starting ref (${switchDetail}), ` +
            `and the git worktree fallback at ${worktreeTarget} also failed.`,
        },
      );
      yield* configureBaseRef(worktreeTarget);
      return {
        worktree: {
          path: worktreeTarget,
          refName: targetBranch,
        },
      };
    }

    yield* configureBaseRef(worktreePath);

    return {
      worktree: {
        path: worktreePath,
        refName: targetBranch,
      },
    };
  });

  const fetchPullRequestBranch: GitVcsDriver.GitVcsDriver["Service"]["fetchPullRequestBranch"] =
    Effect.fn("fetchPullRequestBranch")(function* (input) {
      const remoteName = yield* resolvePrimaryRemoteName(input.cwd);
      yield* executeGit(
        "GitVcsDriver.fetchPullRequestBranch",
        input.cwd,
        [
          "fetch",
          "--quiet",
          "--no-tags",
          remoteName,
          `+refs/pull/${input.prNumber}/head:refs/heads/${input.branch}`,
        ],
        {
          fallbackErrorDetail: "git fetch pull request branch failed",
        },
      );
    });

  const fetchRemote: GitVcsDriver.GitVcsDriver["Service"]["fetchRemote"] = Effect.fn("fetchRemote")(
    function* (input) {
      yield* executeGit(
        "GitVcsDriver.fetchRemote",
        input.cwd,
        ["fetch", "--quiet", input.remoteName],
        {
          env: STATUS_UPSTREAM_REFRESH_ENV,
          fallbackErrorDetail: `git fetch ${input.remoteName} failed`,
        },
      );
    },
  );

  const resolveRemoteTrackingCommit: GitVcsDriver.GitVcsDriver["Service"]["resolveRemoteTrackingCommit"] =
    Effect.fn("resolveRemoteTrackingCommit")(function* (input) {
      const remoteNames = yield* listRemoteNames(input.cwd);
      const parsedRemoteRef = parseRemoteRefWithRemoteNames(
        input.refName,
        remoteNames.toSorted((left, right) => right.length - left.length),
      );
      const remoteRefName =
        parsedRemoteRef?.remoteRef ?? `${input.fallbackRemoteName}/${input.refName}`;
      const commitSha = yield* runGitStdout("GitVcsDriver.resolveRemoteTrackingCommit", input.cwd, [
        "rev-parse",
        "--verify",
        `refs/remotes/${remoteRefName}^{commit}`,
      ]).pipe(Effect.map((stdout) => stdout.trim()));

      return { commitSha, remoteRefName };
    });

  const fetchRemoteBranch: GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteBranch"] = Effect.fn(
    "fetchRemoteBranch",
  )(function* (input) {
    yield* runGit("GitVcsDriver.fetchRemoteBranch.fetch", input.cwd, [
      "fetch",
      "--quiet",
      "--no-tags",
      input.remoteName,
      `+refs/heads/${input.remoteBranch}:refs/remotes/${input.remoteName}/${input.remoteBranch}`,
    ]);

    const localBranchAlreadyExists = yield* branchExists(input.cwd, input.localBranch);
    const targetRef = `${input.remoteName}/${input.remoteBranch}`;
    yield* runGit(
      "GitVcsDriver.fetchRemoteBranch.materialize",
      input.cwd,
      localBranchAlreadyExists
        ? ["branch", "--force", input.localBranch, targetRef]
        : ["branch", input.localBranch, targetRef],
    );
  });

  const fetchRemoteTrackingBranch: GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteTrackingBranch"] =
    Effect.fn("fetchRemoteTrackingBranch")(function* (input) {
      yield* runGit("GitVcsDriver.fetchRemoteTrackingBranch", input.cwd, [
        "fetch",
        "--quiet",
        "--no-tags",
        input.remoteName,
        `+refs/heads/${input.remoteBranch}:refs/remotes/${input.remoteName}/${input.remoteBranch}`,
      ]);
    });

  const setBranchUpstream: GitVcsDriver.GitVcsDriver["Service"]["setBranchUpstream"] = (input) =>
    runGit("GitVcsDriver.setBranchUpstream", input.cwd, [
      "branch",
      "--set-upstream-to",
      `${input.remoteName}/${input.remoteBranch}`,
      input.branch,
    ]);

  const removeWorktree: GitVcsDriver.GitVcsDriver["Service"]["removeWorktree"] = Effect.fn(
    "removeWorktree",
  )(function* (input) {
    const args = ["remove"];
    if (input.force) {
      args.push("-f");
    }
    args.push(input.path);
    const riftResult = yield* Effect.result(
      executeRift("GitVcsDriver.removeWorktree", input.cwd, args, 15_000),
    );
    if (Result.isSuccess(riftResult)) {
      return;
    }

    // Boxes without reflink support get plain git worktrees from
    // `createWorktree`'s fallback, and `rift remove` does not know about those.
    // Try git's own removal before reporting the rift failure, so teardown
    // works on ext4 too.
    const gitArgs = ["worktree", "remove"];
    if (input.force) {
      gitArgs.push("--force");
    }
    gitArgs.push(input.path);
    const gitResult = yield* Effect.result(
      executeGit("GitVcsDriver.removeWorktree.gitWorktreeRemove", input.cwd, gitArgs, {
        timeoutMs: 15_000,
      }),
    );
    if (Result.isFailure(gitResult)) {
      return yield* riftResult.failure;
    }
  });

  const renameBranch: GitVcsDriver.GitVcsDriver["Service"]["renameBranch"] = Effect.fn(
    "renameBranch",
  )(function* (input) {
    if (input.oldBranch === input.newBranch) {
      return { branch: input.newBranch };
    }
    const targetBranch = yield* resolveAvailableBranchName(input.cwd, input.newBranch);

    yield* executeGit(
      "GitVcsDriver.renameBranch",
      input.cwd,
      ["branch", "-m", "--", input.oldBranch, targetBranch],
      {
        timeoutMs: 10_000,
        fallbackErrorDetail: "git branch rename failed",
      },
    );

    return { branch: targetBranch };
  });

  const switchRef: GitVcsDriver.GitVcsDriver["Service"]["switchRef"] = Effect.fn("switchRef")(
    function* (input) {
      const [localInputExists, remoteExists] = yield* Effect.all(
        [
          executeGit(
            "GitVcsDriver.switchRef.localInputExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/heads/${input.refName}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.exitCode === 0)),
          executeGit(
            "GitVcsDriver.switchRef.remoteExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/remotes/${input.refName}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.exitCode === 0)),
        ],
        { concurrency: "unbounded" },
      );

      const localTrackingBranch = remoteExists
        ? yield* executeGit(
            "GitVcsDriver.switchRef.localTrackingBranch",
            input.cwd,
            ["for-each-ref", "--format=%(refname:short)\t%(upstream:short)", "refs/heads"],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(
            Effect.map((result) =>
              result.exitCode === 0
                ? parseTrackingBranchByUpstreamRef(result.stdout, input.refName)
                : null,
            ),
          )
        : null;

      const localTrackedBranchCandidate = deriveLocalBranchNameFromRemoteRef(input.refName);
      const localTrackedBranchTargetExists =
        remoteExists && localTrackedBranchCandidate
          ? yield* executeGit(
              "GitVcsDriver.switchRef.localTrackedBranchTargetExists",
              input.cwd,
              ["show-ref", "--verify", "--quiet", `refs/heads/${localTrackedBranchCandidate}`],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ).pipe(Effect.map((result) => result.exitCode === 0))
          : false;

      const checkoutArgs = localInputExists
        ? ["checkout", input.refName]
        : remoteExists && !localTrackingBranch && localTrackedBranchTargetExists
          ? ["checkout", input.refName]
          : remoteExists && !localTrackingBranch
            ? ["checkout", "--track", input.refName]
            : remoteExists && localTrackingBranch
              ? ["checkout", localTrackingBranch]
              : ["checkout", input.refName];

      yield* executeGit("GitVcsDriver.switchRef.checkout", input.cwd, checkoutArgs, {
        timeoutMs: 10_000,
        fallbackErrorDetail: `Failed to switch to '${input.refName}'. If the working tree has uncommitted changes that would be overwritten, commit, stash, or discard them, then retry.`,
      });

      const refName = yield* runGitStdout("GitVcsDriver.switchRef.currentBranch", input.cwd, [
        "branch",
        "--show-current",
      ]).pipe(Effect.map((stdout) => stdout.trim() || null));

      return { refName };
    },
  );

  const createRef: GitVcsDriver.GitVcsDriver["Service"]["createRef"] = Effect.fn("createRef")(
    function* (input) {
      yield* executeGit("GitVcsDriver.createRef", input.cwd, ["branch", input.refName], {
        timeoutMs: 10_000,
        fallbackErrorDetail: `Failed to create branch '${input.refName}'. A branch with that name may already exist — choose a different name or delete the existing branch first.`,
      });
      if (input.switchRef) {
        yield* switchRef({ cwd: input.cwd, refName: input.refName });
      }

      return { refName: input.refName };
    },
  );

  const initRepo: GitVcsDriver.GitVcsDriver["Service"]["initRepo"] = (input) =>
    executeGit("GitVcsDriver.initRepo", input.cwd, ["init"], {
      timeoutMs: 10_000,
      fallbackErrorDetail: "git init failed",
    }).pipe(Effect.asVoid);

  const listLocalBranchNames: GitVcsDriver.GitVcsDriver["Service"]["listLocalBranchNames"] = (
    cwd,
  ) =>
    runGitStdout("GitVcsDriver.listLocalBranchNames", cwd, [
      "branch",
      "--list",
      "--no-column",
      "--format=%(refname:short)",
    ]).pipe(
      Effect.map((stdout) => {
        const branchNames: Array<string> = [];
        for (const line of stdout.split("\n")) {
          const branchName = line.trim();
          if (branchName.length > 0) {
            branchNames.push(branchName);
          }
        }
        return branchNames;
      }),
    );

  return GitVcsDriver.GitVcsDriver.of({
    execute,
    status,
    statusDetails,
    statusDetailsLocal,
    statusDetailsRemote,
    prepareCommitContext,
    commit,
    pushCurrentBranch,
    pullCurrentBranch,
    readRangeContext,
    getReviewDiffPreview,
    readConfigValue,
    listRefs,
    createWorktree,
    fetchPullRequestBranch,
    ensureRemote,
    resolvePrimaryRemoteName,
    fetchRemote,
    resolveRemoteTrackingCommit,
    fetchRemoteBranch,
    fetchRemoteTrackingBranch,
    setBranchUpstream,
    removeWorktree,
    renameBranch,
    createRef,
    switchRef,
    initRepo,
    listLocalBranchNames,
  });
});
