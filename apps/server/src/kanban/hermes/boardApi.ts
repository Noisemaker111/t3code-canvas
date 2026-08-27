/**
 * The surface a Hermes program may touch, plus the recorder that turns one
 * tick into a readable transcript.
 *
 * @module kanban/hermes/boardApi
 */
import type {
  CanvasDigest,
  CanvasInjectionSpec,
  CanvasMessage,
  HermesCardOperation,
  KanbanCard,
  ComponentId,
  KanbanPrepStatus,
  ModelSelection,
} from "@t3tools/contracts";

export type BoardPendingInput = {
  readonly threadId: string;
  readonly requestId: string;
  readonly question: string;
  readonly options: ReadonlyArray<string>;
};

export type BoardThreadReport = {
  readonly threadId: string;
  /** Closing agent message, raw. Parsed by `agentReport.ts`. */
  readonly text: string;
  readonly finishedAt: string | null;
};

export type BoardTranscriptEntry = {
  readonly at: string;
  /** `user` / `assistant` for messages; the activity kind otherwise. */
  readonly role: string;
  readonly text: string;
};

/**
 * A project as the router and the prompt see it: the name plus the two things
 * a card can actually point at — where it lives and which repo it is.
 */
export type BoardProject = {
  readonly id: string;
  readonly name: string;
  readonly workspaceRoot: string | null;
  readonly repo: string | null;
};

/**
 * One project's answer to a path search: how many files matched and the first
 * of them. This is what makes "which project is this card about" a lookup
 * instead of a guess.
 */
export type BoardProjectSearchHit = {
  readonly projectId: string;
  /** The human slug the prompt shows, so a hit can be routed without the id. */
  readonly slug: string;
  readonly name: string;
  readonly hits: number;
  readonly paths: ReadonlyArray<string>;
};

/**
 * A path search over every project. `ambiguous` is the answer to the question
 * routing actually asks: did more than one checkout claim this path?
 */
export type BoardProjectSearch = {
  readonly query: string;
  readonly ambiguous: boolean;
  /** Only projects with at least one hit, most hits first. */
  readonly projects: ReadonlyArray<BoardProjectSearchHit>;
};

/** An open pull request on a project's repo, as the orphan sweep sees it. */
export type BoardOpenPr = {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  /**
   * What the forge said this pull request is. The list is asked for open ones,
   * but a forge client that drops the filter still reports the real state per
   * row — and a card filed for a merged pull request is pure noise.
   */
  readonly state?: "open" | "closed" | "merged";
};

/** An open issue on a project's repo, as the issue watch sees it. */
export type BoardOpenIssue = {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  /** The forge's own labels, in forge order. */
  readonly labels: ReadonlyArray<string>;
};

/**
 * Enough of a thread to answer "why is this sitting there?" without opening the
 * chat: what state the turn is in, how long it has been quiet, and the tail of
 * what was actually said and done.
 */
export type BoardThreadTranscript = {
  readonly threadId: string;
  readonly title: string;
  readonly exists: boolean;
  readonly archived: boolean;
  /** `running` | `interrupted` | `completed` | `error` | `none`. */
  readonly turnState: string;
  readonly lastActivityAt: string | null;
  readonly idleForMs: number | null;
  readonly messageCount: number;
  readonly entries: ReadonlyArray<BoardTranscriptEntry>;
};

/**
 * A base branch that moved far enough to collide with the card's own work.
 * Everything an agent with no git needs to act on it.
 */
export type BoardPrSyncConflict = {
  readonly baseBranch: string;
  readonly headBranch: string;
  /** Paths git could not merge on its own. */
  readonly files: ReadonlyArray<string>;
  /** What landed on the base branch since the card branched, newest first. */
  readonly baseCommits: ReadonlyArray<string>;
  readonly behindCount: number;
  /** Where the half-merged tree is waiting, when one was left for the agent. */
  readonly worktreePath: string | null;
};

export interface BoardApi {
  list(): Promise<ReadonlyArray<KanbanCard>>;
  updateCard(input: {
    id: string;
    title?: string;
    body?: string;
    at?: ComponentId;
    threadId?: string | null;
    projectId?: string | null;
    projectRouteProvenance?: import("@t3tools/contracts").HermesRouteProvenance | null;
    prepStatus?: KanbanPrepStatus;
    modelSelection?: ModelSelection | null;
    modelRouteReason?: string | null;
    modelRouteProvenance?: import("@t3tools/contracts").HermesRouteProvenance | null;
    modelRouteUsage?: import("@t3tools/contracts").HermesTaskUsageEstimate | null;
    baseBranch?: string | null;
    attachments?: KanbanCard["attachments"];
    prUrl?: string | null;
    prTitle?: string | null;
    prNumber?: number | null;
    /** Rule id to stamp on the move this update makes, for the card's chip. */
    movedBy?: string;
  }): Promise<KanbanCard>;
  createCard(input: {
    title: string;
    body: string;
    at?: ComponentId;
    projectId?: string | null;
    projectRouteProvenance?: import("@t3tools/contracts").HermesRouteProvenance | null;
    prepStatus?: KanbanPrepStatus;
    modelSelection?: ModelSelection | null;
    modelRouteReason?: string | null;
    modelRouteProvenance?: import("@t3tools/contracts").HermesRouteProvenance | null;
    modelRouteUsage?: import("@t3tools/contracts").HermesTaskUsageEstimate | null;
    baseBranch?: string | null;
  }): Promise<KanbanCard>;
  launchActive(input: {
    id: string;
    projectId?: string;
    modelSelection?: ModelSelection;
    forceFreshThread?: boolean;
  }): Promise<{ threadId: string }>;
  openPr(input: { id: string }): Promise<{ prUrl: string | null }>;
  mergePr(input: { id: string }): Promise<{ merged: boolean; reason: string | null }>;
  /**
   * Close a pull request without merging it. `reference` targets a PR the
   * card does not itself own — an orphan-reconcile card closing the PR named
   * in its own body — and defaults to the card's own `prUrl` when omitted.
   */
  closePr(input: {
    id: string;
    reference?: string;
  }): Promise<{ closed: boolean; reason: string | null }>;
  /** The forge's verdict on the card's PR checks. `unknown` means "cannot tell". */
  prChecks(input: { id: string }): Promise<{
    state: "passing" | "failing" | "pending" | "unknown";
    failing: ReadonlyArray<{ name: string; url: string | null }>;
    /**
     * Why the state is `unknown`: `no_checks` is a forge that answered with an
     * empty rollup, `unavailable` is one that did not answer.
     */
    unknownReason?: "no_checks" | "unavailable" | null;
    /** When the PR was opened, epoch ms. Null when the forge did not say. */
    openedAtMs?: number | null;
  }>;
  /**
   * Give a card in PR its worktree back before sending it to Active again.
   * Resolves to the path, or null when the card has none to restore.
   */
  restorePrWorktree(input: { id: string }): Promise<{ worktreePath: string | null }>;
  /**
   * Merge the base branch into the PR head after an un-mergeable `mergePr`.
   * A conflict leaves the half-merged tree in the card's own worktree and
   * describes it, so the thread that wrote the code can reconcile it.
   */
  syncPrBranch(input: { id: string }): Promise<{
    synced: boolean;
    reason: string | null;
    conflict: BoardPrSyncConflict | null;
  }>;
  nudgeThread(input: { threadId: string; text: string }): Promise<void>;
  /**
   * Start an ephemeral helper thread on one question. Returns as soon as the
   * turn is dispatched — the loop reads the answer on a later tick, never here.
   * With `aboutThreadId` the runtime attaches that thread's transcript to the
   * helper's prompt, so Hermes pays no tokens to hand over what it is asking about.
   */
  launchHelper(input: {
    question: string;
    projectId: string;
    modelSelection?: ModelSelection;
    aboutThreadId?: string | null;
  }): Promise<{ threadId: string }>;
  /** Take a thread off the board's sidebar; the reaper takes its worktree back. */
  archiveThread(input: { threadId: string }): Promise<void>;
  threadReport(input: { threadId: string }): Promise<BoardThreadReport | null>;
  threadTranscript(input: {
    threadId: string;
    /** Tail entries to return, newest last. Default 12, max 40. */
    limit?: number;
  }): Promise<BoardThreadTranscript | null>;
  archiveCard(input: { id: string; archived?: boolean }): Promise<KanbanCard>;
  pendingInputs(): Promise<ReadonlyArray<BoardPendingInput>>;
  answerPermission(input: { threadId: string; requestId: string; answer: string }): Promise<void>;
  listModels(): Promise<
    ReadonlyArray<{
      instanceId: string;
      model: string;
      costTier: number;
      usable: boolean;
      /** The owner's rule for this model, verbatim. Empty when none is set. */
      note: string;
      /** Stable selection key used by launch plans. */
      routeId: string;
      /** Exact validated selection, including owner-configured provider options. */
      selection: import("@t3tools/contracts").ModelSelection;
      /** The rule's fixed launch options. */
      options: string;
      /** Owner-approved values Hermes may select, such as thinking effort. */
      optionChoices: ReadonlyArray<{ id: string; values: ReadonlyArray<string> }>;
      capability: import("@t3tools/contracts").HermesRouteCapability;
      speed: import("@t3tools/contracts").HermesRouteSpeed;
      capacity: import("@t3tools/contracts").HermesCapacityPool;
      usage: import("@t3tools/contracts").HermesTaskUsageEstimate;
      meteredPrice: import("@t3tools/contracts").HermesMeteredPrice | null;
      /** Median cost of one whole task on this route, from observed turns. */
      taskCost: import("@t3tools/contracts").HermesTaskCost;
    }>
  >;
  listProjects(): Promise<ReadonlyArray<BoardProject>>;
  /** Which projects contain files matching `query`, with per-project hit counts. */
  searchProjects(input: {
    query: string;
    /** Paths per project. Default 5, max 20. */
    limit?: number;
  }): Promise<BoardProjectSearch>;
  /**
   * Open pull requests on one project's repo, or on a named set of repos.
   * Empty when the project has no checkout; a repo nothing on the board answers
   * to fails rather than returning the pull requests of the ones that matched.
   */
  listOpenPrs(input: {
    projectId?: string;
    repos?: ReadonlyArray<string>;
    limit?: number;
  }): Promise<ReadonlyArray<BoardOpenPr>>;
  /**
   * Open issues, same vocabulary and failure posture as `listOpenPrs`. Fails
   * by name on a forge whose provider cannot list issues.
   */
  listOpenIssues(input: {
    projectId?: string;
    repos?: ReadonlyArray<string>;
    limit?: number;
  }): Promise<ReadonlyArray<BoardOpenIssue>>;
  canvasDigest(): Promise<CanvasDigest>;
  canvasDraw(input: { spec: CanvasInjectionSpec }): Promise<{ id: string }>;
  /**
   * Picture messages nobody has handed to Hermes yet. Image bytes only when
   * asked for: they belong in the prompt, never in a tick transcript.
   */
  canvasInbox(input?: { includeImages?: boolean }): Promise<ReadonlyArray<CanvasMessage>>;
  canvasAckMessages(input: { ids: ReadonlyArray<string> }): Promise<void>;
}

export type BoardCallRecord = {
  /** A `BoardApi` primitive, or the coarse `board.*` verb that drove it. */
  readonly method: string;
  readonly args: unknown;
  readonly result?: unknown;
  readonly error?: string;
  /** True when record-only mode skipped the write. */
  readonly skipped?: boolean;
  /** True when the operation coordinator refused before the call ever ran. */
  readonly refused?: boolean;
  /** Durable mutation receipt. Present for Hermes writes tied to a card. */
  readonly operation?: HermesCardOperation;
  /** True when an already-applied idempotent operation supplied the result. */
  readonly reused?: boolean;
  /** Wall clock for this call. A slow `mergePr` is otherwise invisible. */
  readonly durationMs?: number;
};

/**
 * The failure a call carries, whether it threw or answered with refusal data.
 * `mergePr`, `syncPrBranch` and `closePr` return `{merged:false}` /
 * `{synced:false}` / `{closed:false}` as data on purpose — a program can
 * recover from them — but every reader of the transcript (chat feed, result
 * turn, card activity) must not render that as "ok": that is how a card stuck
 * on an unmergeable PR read "Hermes merged".
 */
export function boardCallFailure(call: {
  readonly method: string;
  readonly result?: unknown;
  readonly error?: string | undefined;
}): string | null {
  if (call.error !== undefined) return call.error;
  const result = call.result;
  if (result === null || typeof result !== "object") return null;
  const record = result as {
    merged?: unknown;
    synced?: unknown;
    closed?: unknown;
    reason?: unknown;
  };
  const failed =
    (call.method === "mergePr" && record.merged === false) ||
    (call.method === "syncPrBranch" && record.synced === false) ||
    (call.method === "closePr" && record.closed === false);
  if (!failed) return null;
  return typeof record.reason === "string" && record.reason.length > 0
    ? record.reason
    : `${call.method} did not apply`;
}

/** Calls with a durable external effect. The unit both the log and the summary count. */
export const BOARD_WRITE_METHODS: ReadonlySet<string> = new Set([
  "updateCard",
  "createCard",
  "launchActive",
  "openPr",
  "mergePr",
  "closePr",
  "syncPrBranch",
  "nudgeThread",
  "launchHelper",
  "archiveThread",
  "answerPermission",
  "archiveCard",
  "canvasDraw",
  "canvasAckMessages",
  // Composite verb: writes to the durable Hermes chat rather than BoardApi.
  "askUser",
]);

export interface BoardOperationCoordinator {
  readonly execute: (input: {
    readonly method: keyof BoardApi;
    readonly args: unknown;
    readonly invoke: () => Promise<unknown>;
  }) => Promise<{
    readonly result: unknown;
    readonly operation?: HermesCardOperation;
    readonly reused?: boolean;
  }>;
}

export class BoardOperationStateError extends Error {
  readonly operation: HermesCardOperation;
  /** The coordinator refused before invoking, so the board call never ran. */
  readonly refused: boolean;

  constructor(
    operation: HermesCardOperation,
    options: { readonly exhausted?: boolean; readonly refused?: boolean } = {},
  ) {
    const detail = operation.error ?? "no result was recorded";
    super(
      operation.status === "running"
        ? `${operation.detail} is already running`
        : options.exhausted === true
          ? `${operation.detail} ${operation.status} on all ${operation.attempt} attempts and will not be retried until the board changes or Hermes restarts: ${detail}`
          : `${operation.detail} ${operation.status} on attempt ${operation.attempt}: ${detail}`,
    );
    this.name = "BoardOperationStateError";
    this.operation = operation;
    this.refused = options.refused === true;
  }
}

const READ_ONLY_METHODS = new Set<keyof BoardApi>([
  "list",
  "threadReport",
  "threadTranscript",
  "pendingInputs",
  "listModels",
  "listProjects",
  "searchProjects",
  "listOpenPrs",
  "listOpenIssues",
  // Reading the canvas is a read: a dry run that could not see what is drawn
  // would report a program as fine when it drew over the human's work.
  "canvasDigest",
  "canvasInbox",
]);

export type BoardRecorder = {
  readonly api: BoardApi;
  readonly calls: ReadonlyArray<BoardCallRecord>;
  readonly callCount: () => number;
};

export class BoardCallLimitError extends Error {
  constructor(limit: number) {
    super(`Hermes program exceeded ${limit} board calls in one tick`);
    this.name = "BoardCallLimitError";
  }
}

/**
 * Wrap a `BoardApi` so every call lands in a transcript.
 *
 * `recordOnly` is the dry run: reads still hit the real board (the panel shows
 * what Hermes actually saw), writes resolve to a stub and are marked skipped.
 */
export function makeBoardRecorder(input: {
  readonly api: BoardApi;
  readonly recordOnly?: boolean;
  readonly maxCalls?: number;
  /** Share one transcript across layers — the verbs and the primitives below them. */
  readonly calls?: BoardCallRecord[];
  readonly operations?: BoardOperationCoordinator;
}): BoardRecorder {
  const calls = input.calls ?? [];
  const maxCalls = input.maxCalls ?? 64;
  const recordOnly = input.recordOnly === true;

  const wrap = <M extends keyof BoardApi>(method: M): BoardApi[M] =>
    (async (args: unknown) => {
      if (calls.length >= maxCalls) throw new BoardCallLimitError(maxCalls);
      if (recordOnly && !READ_ONLY_METHODS.has(method)) {
        calls.push({ method, args, skipped: true });
        return null;
      }
      const startedMs = Date.now();
      const elapsed = () => Math.max(0, Date.now() - startedMs);
      try {
        const fn = input.api[method] as (value: unknown) => Promise<unknown>;
        const invoke = () => fn.call(input.api, args);
        const coordinated: {
          result: unknown;
          operation?: HermesCardOperation;
          reused?: boolean;
        } = input.operations
          ? await input.operations.execute({ method, args, invoke })
          : { result: await invoke() };
        calls.push({
          method,
          args,
          result: coordinated.result,
          durationMs: elapsed(),
          ...(coordinated.operation ? { operation: coordinated.operation } : {}),
          ...(coordinated.reused === true ? { reused: true } : {}),
        });
        return coordinated.result;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        calls.push({
          method,
          args,
          error: message,
          durationMs: elapsed(),
          ...(cause instanceof BoardOperationStateError ? { operation: cause.operation } : {}),
          ...(cause instanceof BoardOperationStateError && cause.refused ? { refused: true } : {}),
        });
        throw cause instanceof Error ? cause : new Error(message);
      }
    }) as BoardApi[M];

  const api = {
    list: wrap("list"),
    updateCard: wrap("updateCard"),
    createCard: wrap("createCard"),
    launchActive: wrap("launchActive"),
    openPr: wrap("openPr"),
    mergePr: wrap("mergePr"),
    closePr: wrap("closePr"),
    prChecks: wrap("prChecks"),
    restorePrWorktree: wrap("restorePrWorktree"),
    syncPrBranch: wrap("syncPrBranch"),
    nudgeThread: wrap("nudgeThread"),
    launchHelper: wrap("launchHelper"),
    archiveThread: wrap("archiveThread"),
    threadReport: wrap("threadReport"),
    threadTranscript: wrap("threadTranscript"),
    archiveCard: wrap("archiveCard"),
    pendingInputs: wrap("pendingInputs"),
    answerPermission: wrap("answerPermission"),
    listModels: wrap("listModels"),
    listProjects: wrap("listProjects"),
    searchProjects: wrap("searchProjects"),
    listOpenPrs: wrap("listOpenPrs"),
    listOpenIssues: wrap("listOpenIssues"),
    canvasDigest: wrap("canvasDigest"),
    canvasDraw: wrap("canvasDraw"),
    canvasInbox: wrap("canvasInbox"),
    canvasAckMessages: wrap("canvasAckMessages"),
  } satisfies BoardApi;

  return { api, calls, callCount: () => calls.length };
}

/**
 * Record the composite verbs a program calls into the same transcript as the
 * primitives they drive, so a `finishCard` row is followed by the `openPr` row
 * that made it up. Pass-through verbs are left alone — they already record
 * themselves one layer down, and wrapping them would double
 * every nudge and every update. Verbs always run: their guards, not the
 * recorder, decide what a dry run touches.
 */
export function recordVerbCalls<T extends Record<string, unknown>>(input: {
  readonly target: T;
  readonly calls: BoardCallRecord[];
  readonly maxCalls?: number;
  /** Method names to record at this layer. */
  readonly only: ReadonlySet<string>;
}): T {
  const maxCalls = input.maxCalls ?? 64;
  const entries = Object.entries(input.target).map(([method, value]) => {
    if (typeof value !== "function" || !input.only.has(method)) return [method, value] as const;
    const fn = value as (args: unknown) => Promise<unknown>;
    const wrapped = async (args: unknown) => {
      if (input.calls.length >= maxCalls) throw new BoardCallLimitError(maxCalls);
      const index = input.calls.push({ method, args }) - 1;
      try {
        const result = await fn(args);
        input.calls[index] = { method, args, result };
        return result;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        input.calls[index] = { method, args, error: message };
        throw cause instanceof Error ? cause : new Error(message);
      }
    };
    return [method, wrapped] as const;
  });
  return Object.fromEntries(entries) as T;
}
