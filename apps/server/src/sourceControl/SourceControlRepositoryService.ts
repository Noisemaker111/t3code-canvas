import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  SourceControlRepositoryError,
  type SourceControlCloneRepositoryInput,
  type SourceControlCloneRepositoryResult,
  type SourceControlCloneProtocol,
  type SourceControlProviderKind,
  type SourceControlPublishRepositoryInput,
  type SourceControlPublishRepositoryResult,
  type SourceControlRepositoryCloneUrls,
  type SourceControlRepositoryInfo,
  type SourceControlRepositoryLookupInput,
  type SourceControlRepositoryListInput,
} from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
const isSourceControlRepositoryError = Schema.is(SourceControlRepositoryError);

export class SourceControlRepositoryService extends Context.Service<
  SourceControlRepositoryService,
  {
    readonly lookupRepository: (
      input: SourceControlRepositoryLookupInput,
    ) => Effect.Effect<SourceControlRepositoryInfo, SourceControlRepositoryError>;
    readonly listRepositories: (
      input: SourceControlRepositoryListInput,
    ) => Effect.Effect<ReadonlyArray<SourceControlRepositoryInfo>, SourceControlRepositoryError>;
    readonly cloneRepository: (
      input: SourceControlCloneRepositoryInput,
    ) => Effect.Effect<SourceControlCloneRepositoryResult, SourceControlRepositoryError>;
    readonly publishRepository: (
      input: SourceControlPublishRepositoryInput,
    ) => Effect.Effect<SourceControlPublishRepositoryResult, SourceControlRepositoryError>;
  }
>()("t3/sourceControl/SourceControlRepositoryService") {}

function mapRepositoryError(operation: string, provider: SourceControlProviderKind) {
  return Effect.mapError((cause: unknown) =>
    isSourceControlRepositoryError(cause)
      ? cause
      : new SourceControlRepositoryError({
          operation,
          provider,
          detail: "The source control operation could not be completed.",
          cause,
        }),
  );
}

function toRepositoryInfo(
  provider: SourceControlProviderKind,
  urls: SourceControlRepositoryCloneUrls,
): SourceControlRepositoryInfo {
  return {
    provider,
    nameWithOwner: urls.nameWithOwner,
    url: urls.url,
    sshUrl: urls.sshUrl,
  };
}

function selectRemoteUrl(
  urls: SourceControlRepositoryCloneUrls,
  protocol: SourceControlCloneProtocol | undefined,
): string {
  switch (protocol ?? "auto") {
    case "https":
      return urls.url;
    case "ssh":
    case "auto":
      return urls.sshUrl;
  }
}

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(NodeOS.homedir(), input.slice(2));
  }
  return input;
}

// Reduce a git remote URL to a comparable `host/owner/repo` identity so that
// `https://github.com/o/r`, `https://github.com/o/r.git`, and
// `git@github.com:o/r.git` all match. Used to decide whether an existing
// checkout at the clone destination is the SAME repository we were asked to
// clone (adopt it) or a different one (refuse with an actionable error).
function canonicalRepoIdentity(url: string): string {
  let value = url.trim().replace(/\.git$/i, "");
  // scp-like syntax: [user@]host:owner/repo
  const scpMatch = /^(?:[^/@]+@)?([^/:]+):(.+)$/.exec(value);
  if (scpMatch && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return `${scpMatch[1]}/${scpMatch[2]}`.replace(/\/+$/g, "").toLowerCase();
  }
  // URL with an explicit scheme: scheme://[user@]host/owner/repo
  const schemeMatch = /^[a-z][a-z0-9+.-]*:\/\/(.+)$/i.exec(value);
  if (schemeMatch) {
    let rest = schemeMatch[1] ?? "";
    const atIndex = rest.indexOf("@");
    if (atIndex >= 0) {
      rest = rest.slice(atIndex + 1);
    }
    return rest.replace(/\/+$/g, "").toLowerCase();
  }
  return value.replace(/\/+$/g, "").toLowerCase();
}

function repoIdentitiesMatch(left: string, right: string): boolean {
  return canonicalRepoIdentity(left) === canonicalRepoIdentity(right);
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;

  const ensureConcreteProvider = (input: {
    readonly operation: string;
    readonly provider: SourceControlProviderKind;
  }) => {
    if (input.provider !== "unknown") {
      return Effect.succeed(input.provider);
    }

    return Effect.fail(
      new SourceControlRepositoryError({
        operation: input.operation,
        provider: input.provider,
        detail: "Choose a source control provider before continuing.",
      }),
    );
  };

  const lookupRepository = Effect.fn("SourceControlRepositoryService.lookupRepository")(function* (
    input: SourceControlRepositoryLookupInput,
  ) {
    const providerKind = yield* ensureConcreteProvider({
      operation: "lookupRepository",
      provider: input.provider,
    });
    const provider = yield* providers.get(providerKind);
    const urls = yield* provider.getRepositoryCloneUrls({
      cwd: input.cwd ?? config.cwd,
      repository: input.repository.trim(),
    });
    return toRepositoryInfo(providerKind, urls);
  });
  const listRepositories = Effect.fn("SourceControlRepositoryService.listRepositories")(function* (
    input: SourceControlRepositoryListInput,
  ) {
    const providerKind = yield* ensureConcreteProvider({
      operation: "listRepositories",
      provider: input.provider,
    });
    const provider = yield* providers.get(providerKind);
    if (providerKind !== "github") {
      return yield* new SourceControlRepositoryError({
        operation: "listRepositories",
        provider: providerKind,
        detail: "Repository listing is currently supported for GitHub only.",
      });
    }
    if (!provider.listRepositories) {
      return yield* new SourceControlRepositoryError({
        operation: "listRepositories",
        provider: providerKind,
        detail: "Repository listing is not supported by this provider.",
      });
    }
    const urls = yield* provider.listRepositories({ cwd: input.cwd ?? config.cwd });
    return urls.map((item) => toRepositoryInfo(providerKind, item));
  });

  const normalizeDestinationPath = Effect.fn("SourceControlRepositoryService.normalizeDestination")(
    function* (destinationPath: string) {
      const trimmed = destinationPath.trim();
      if (trimmed.length === 0) {
        return yield* new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider: "unknown",
          detail: "Choose a destination path before cloning.",
        });
      }

      return path.resolve(expandHomePath(trimmed, path));
    },
  );

  // Read the `origin` remote URL of an on-disk directory, returning null when it
  // is not a git repository (or has no origin). Never fails: an inaccessible or
  // non-repo directory simply reports "no origin" so the caller can produce an
  // actionable clone error rather than a raw git failure.
  const readOriginRemoteUrl = (directoryPath: string) =>
    git
      .execute({
        operation: "SourceControlRepositoryService.cloneRepository.probeOrigin",
        cwd: directoryPath,
        args: ["remote", "get-url", "origin"],
        allowNonZeroExit: true,
        timeoutMs: 15_000,
      })
      .pipe(
        Effect.map((result) => {
          if (result.exitCode !== 0) {
            return null;
          }
          const trimmed = result.stdout.trim();
          return trimmed.length > 0 ? trimmed : null;
        }),
        Effect.orElseSucceed(() => null),
      );

  const cloneRepository = Effect.fn("SourceControlRepositoryService.cloneRepository")(function* (
    input: SourceControlCloneRepositoryInput,
  ) {
    const normalizedDestination = yield* normalizeDestinationPath(input.destinationPath);
    const parentPath = path.dirname(normalizedDestination);
    const directoryName = path.basename(normalizedDestination);

    // Resolve the requested remote up front so we can compare it against any
    // checkout that already occupies the destination before deciding to clone.
    let repository: SourceControlRepositoryInfo | null = null;
    let remoteUrl = input.remoteUrl?.trim() ?? null;
    let provider: SourceControlProviderKind = input.provider ?? "unknown";

    if (input.provider && input.repository) {
      repository = yield* lookupRepository({
        provider: input.provider,
        repository: input.repository,
        cwd: parentPath,
      });
      remoteUrl = selectRemoteUrl(repository, input.protocol);
      provider = input.provider;
    }

    if (!remoteUrl) {
      return yield* new SourceControlRepositoryError({
        operation: "cloneRepository",
        provider,
        detail: "Enter a repository path or clone URL before cloning.",
      });
    }

    if (yield* fileSystem.exists(normalizedDestination)) {
      const entries = yield* fileSystem
        .readDirectory(normalizedDestination, { recursive: false })
        .pipe(
          Effect.mapError(
            (cause) =>
              new SourceControlRepositoryError({
                operation: "cloneRepository",
                provider,
                detail: `Destination path ${normalizedDestination} already exists and is not a directory. Choose another destination or remove it before cloning.`,
                cause,
              }),
          ),
        );
      if (entries.length > 0) {
        // A non-empty destination can never be `git clone`d into. If it is
        // already a checkout of the SAME repository, adopt it (delete → re-add
        // is idempotent). Otherwise refuse with a message that names the path
        // and the recovery actions instead of a raw git error.
        const existingOrigin = yield* readOriginRemoteUrl(normalizedDestination);
        if (existingOrigin && repoIdentitiesMatch(existingOrigin, remoteUrl)) {
          yield* Effect.logInfo(
            `Adopting existing checkout at ${normalizedDestination} (origin ${existingOrigin}) instead of cloning ${remoteUrl}.`,
          );
          return {
            cwd: normalizedDestination,
            remoteUrl: existingOrigin,
            repository,
          };
        }

        return yield* new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider,
          detail: existingOrigin
            ? `Destination path ${normalizedDestination} already contains a different git repository (origin ${existingOrigin}), which does not match ${remoteUrl}. Add that folder as an existing project, choose another destination, or remove the directory before cloning.`
            : `Destination path ${normalizedDestination} already exists and is not empty, and is not a git checkout of ${remoteUrl}. Add that folder as an existing project, choose another destination, or remove the directory before cloning.`,
        });
      }
    } else {
      yield* fileSystem.makeDirectory(parentPath, { recursive: true });
    }

    yield* git.execute({
      operation: "SourceControlRepositoryService.cloneRepository",
      cwd: parentPath,
      args: ["clone", remoteUrl, directoryName],
      timeoutMs: 120_000,
      maxOutputBytes: 256 * 1024,
    });

    return {
      cwd: normalizedDestination,
      remoteUrl,
      repository,
    };
  });

  const publishRepository = Effect.fn("SourceControlRepositoryService.publishRepository")(
    function* (input: SourceControlPublishRepositoryInput) {
      const providerKind = yield* ensureConcreteProvider({
        operation: "publishRepository",
        provider: input.provider,
      });
      const provider = yield* providers.get(providerKind);
      const urls = yield* provider.createRepository({
        cwd: input.cwd,
        repository: input.repository.trim(),
        visibility: input.visibility,
      });
      const remoteUrl = selectRemoteUrl(urls, input.protocol);
      const remoteName = yield* git.ensureRemote({
        cwd: input.cwd,
        preferredName: input.remoteName?.trim() || "origin",
        url: remoteUrl,
      });

      // An empty local repo (no commits) would make `git push HEAD:...` fail
      // with an opaque "src refspec HEAD does not match any". Treat this as a
      // partial success: the remote was created and wired up, but there is
      // nothing to push yet.
      const hasCommits = yield* git
        .execute({
          operation: "SourceControlRepositoryService.publishRepository.headCheck",
          cwd: input.cwd,
          args: ["rev-parse", "--verify", "HEAD"],
        })
        .pipe(
          Effect.map(() => true),
          Effect.orElseSucceed(() => false),
        );
      if (!hasCommits) {
        const details = yield* git.statusDetails(input.cwd).pipe(Effect.orElseSucceed(() => null));
        return {
          repository: toRepositoryInfo(providerKind, urls),
          remoteName,
          remoteUrl,
          branch: details?.branch ?? "main",
          status: "remote_added" as const,
        };
      }

      const pushResult = yield* git.pushCurrentBranch(input.cwd, null, { remoteName });

      return {
        repository: toRepositoryInfo(providerKind, urls),
        remoteName,
        remoteUrl,
        branch: pushResult.branch,
        ...(pushResult.upstreamBranch ? { upstreamBranch: pushResult.upstreamBranch } : {}),
        status: "pushed" as const,
      };
    },
  );

  return SourceControlRepositoryService.of({
    lookupRepository: (input) =>
      lookupRepository(input).pipe(mapRepositoryError("lookupRepository", input.provider)),
    listRepositories: (input) =>
      listRepositories(input).pipe(mapRepositoryError("listRepositories", input.provider)),
    cloneRepository: (input) =>
      cloneRepository(input).pipe(
        mapRepositoryError("cloneRepository", input.provider ?? "unknown"),
      ),
    publishRepository: (input) =>
      publishRepository(input).pipe(mapRepositoryError("publishRepository", input.provider)),
  });
});

export const layer = Layer.effect(SourceControlRepositoryService, make);
