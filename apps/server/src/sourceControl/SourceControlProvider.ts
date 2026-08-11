import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type {
  ChangeRequest,
  ChangeRequestState,
  ForgeIssue,
  SourceControlProviderError,
  SourceControlProviderInfo,
  SourceControlProviderKind,
  SourceControlRepositoryCloneUrls,
  SourceControlRepositoryVisibility,
} from "@t3tools/contracts";

export interface SourceControlProviderContext {
  readonly provider: SourceControlProviderInfo;
  readonly remoteName: string;
  readonly remoteUrl: string;
}

/** One failing check, named the way the forge names it. */
export interface ChangeRequestCheck {
  readonly name: string;
  readonly url: string | null;
}

/** How many checks landed in each verdict. All zero when the forge has none. */
export interface ChangeRequestCheckCounts {
  readonly total: number;
  readonly passing: number;
  readonly failing: number;
  readonly pending: number;
}

/**
 * Why a rollup read came back `unknown`. `no_checks` is the forge answering
 * with an empty rollup; `unavailable` is any read that did not answer at all.
 * A merge gate must never treat the second as the first.
 */
export type ChangeRequestChecksUnknownReason = "no_checks" | "unavailable";

export interface ChangeRequestChecks {
  /** `unknown` when the forge reports no checks at all — not a pass. */
  readonly state: "passing" | "failing" | "pending" | "unknown";
  readonly failing: ReadonlyArray<ChangeRequestCheck>;
  readonly counts: ChangeRequestCheckCounts;
  /** Set whenever `state` is `unknown`. */
  readonly unknownReason?: ChangeRequestChecksUnknownReason | null;
  /** Human-readable provider detail when the check read was unavailable. */
  readonly unknownDetail?: string | null;
  /** When the change request was opened, epoch ms. Null when the forge did not say. */
  readonly openedAtMs?: number | null;
  /** Current forge state when the check read returned it in the same response. */
  readonly changeRequestState?: ChangeRequestState;
}

export function unavailableChangeRequestChecks(detail: string): ChangeRequestChecks {
  return {
    state: "unknown",
    failing: [],
    counts: { total: 0, passing: 0, failing: 0, pending: 0 },
    unknownReason: "unavailable",
    unknownDetail: detail,
    openedAtMs: null,
  };
}

export interface SourceControlRefSelector {
  readonly refName: string;
  readonly owner?: string;
  readonly repository?: string;
}

const MAX_ERROR_TRANSPORT_VALUE_LENGTH = 256;

/**
 * Sanitizes user-provided source-control identifiers before attaching them to
 * contract errors. This is intentionally narrower than request validation: it
 * only strips URL secrets and bounds diagnostic values sent over transport.
 */
export function transportSafeSourceControlErrorValue(value: string): string {
  let printable = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    printable += codePoint !== undefined && (codePoint < 32 || codePoint === 127) ? " " : character;
  }
  const normalized = printable.trim().replace(/\s+/gu, " ");

  let safe = normalized;
  try {
    const url = new URL(normalized);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    safe = url.toString();
  } catch {
    // Plain repository and change-request identifiers are not URLs.
  }

  return safe.slice(0, MAX_ERROR_TRANSPORT_VALUE_LENGTH);
}

export function parseSourceControlOwnerRef(
  headSelector: string,
): SourceControlRefSelector | undefined {
  const match = /^([^:/\s]+):(.+)$/u.exec(headSelector.trim());
  const owner = match?.[1]?.trim();
  const refName = match?.[2]?.trim();
  return owner && refName ? { owner, refName } : undefined;
}

export function normalizeSourceBranch(headSelector: string): string {
  return parseSourceControlOwnerRef(headSelector)?.refName ?? headSelector.trim();
}

export function sourceBranch(input: {
  readonly headSelector: string;
  readonly source?: SourceControlRefSelector;
}): string {
  return input.source?.refName ?? normalizeSourceBranch(input.headSelector);
}

export function sourceControlRefFromInput(input: {
  readonly headSelector: string;
  readonly source?: SourceControlRefSelector;
}): SourceControlRefSelector | undefined {
  return input.source ?? parseSourceControlOwnerRef(input.headSelector);
}

export class SourceControlProvider extends Context.Service<
  SourceControlProvider,
  {
    readonly kind: SourceControlProviderKind;
    readonly listChangeRequests: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
      readonly source?: SourceControlRefSelector;
      readonly headSelector: string;
      readonly state: ChangeRequestState | "all";
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<ChangeRequest>, SourceControlProviderError>;
    /**
     * Open issues on the repo the checkout tracks. Optional: only forges whose
     * CLI can list issues non-interactively implement this, and the board
     * reports "listing issues is not supported for <forge> yet" for the rest —
     * an unimplemented forge must never read as a repo with no issues.
     */
    readonly listIssues?: (input: {
      readonly cwd: string;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<ForgeIssue>, SourceControlProviderError>;
    readonly getChangeRequest: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
      readonly reference: string;
    }) => Effect.Effect<ChangeRequest, SourceControlProviderError>;
    readonly createChangeRequest: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
      readonly source?: SourceControlRefSelector;
      readonly target?: SourceControlRefSelector;
      readonly baseRefName: string;
      readonly headSelector: string;
      readonly title: string;
      readonly bodyFile: string;
    }) => Effect.Effect<void, SourceControlProviderError>;
    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
      readonly repository: string;
    }) => Effect.Effect<SourceControlRepositoryCloneUrls, SourceControlProviderError>;
    readonly listRepositories?: (input: {
      readonly cwd: string;
    }) => Effect.Effect<
      ReadonlyArray<SourceControlRepositoryCloneUrls>,
      SourceControlProviderError
    >;
    readonly createRepository: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly visibility: SourceControlRepositoryVisibility;
    }) => Effect.Effect<SourceControlRepositoryCloneUrls, SourceControlProviderError>;
    readonly getDefaultBranch: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
    }) => Effect.Effect<string | null, SourceControlProviderError>;
    readonly checkoutChangeRequest: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
      readonly reference: string;
      readonly force?: boolean;
    }) => Effect.Effect<void, SourceControlProviderError>;
    /**
     * Merge an open change request. Optional: only forges whose CLI can do it
     * non-interactively implement this, and the board reports "merging is not
     * supported for <forge> yet" for the rest.
     *
     * Resolves to the merge commit when the forge reports one. A conflicted
     * merge, a failing required check or a missing approval must fail, not
     * resolve — the board only advances the card on success.
     */
    readonly mergeChangeRequest?: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
      readonly reference: string;
    }) => Effect.Effect<string | null, SourceControlProviderError>;

    /**
     * Close a change request without merging it. Optional, same reason as
     * `mergeChangeRequest`: only forges whose CLI can do it non-interactively
     * implement this, and the board reports "closing is not supported for
     * <forge> yet" for the rest.
     */
    readonly closeChangeRequest?: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
      readonly reference: string;
    }) => Effect.Effect<void, SourceControlProviderError>;

    /**
     * The forge's own verdict on a change request's checks.
     *
     * Without it a red pipeline is only visible as a merge that keeps failing,
     * so the board retries against a wall instead of sending the failure back
     * to the thread that caused it.
     */
    readonly getChangeRequestChecks?: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
      readonly reference: string;
    }) => Effect.Effect<ChangeRequestChecks, SourceControlProviderError>;
  }
>()("t3/sourceControl/SourceControlProvider") {}
