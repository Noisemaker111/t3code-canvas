import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { CanvasUiSettings, DEFAULT_CANVAS_UI_SETTINGS } from "./canvas.ts";
import { DEFAULT_HERMES_BUDGET_POSITION, HermesTickBudget } from "./hermesBudget.ts";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_MODEL,
  ProviderOptionSelections,
} from "./model.ts";
import { ModelSelection } from "./orchestration.ts";
import { ProviderInstanceConfig, ProviderInstanceId } from "./providerInstance.ts";

// ── Client Settings (local-only) ───────────────────────────────

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "updated_at";

export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
export const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

export const SidebarProjectGroupingMode = Schema.Literals([
  "repository",
  "repository_path",
  "separate",
]);
export type SidebarProjectGroupingMode = typeof SidebarProjectGroupingMode.Type;
export const DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE: SidebarProjectGroupingMode = "repository";
export const MIN_SIDEBAR_THREAD_PREVIEW_COUNT = 1;
export const MAX_SIDEBAR_THREAD_PREVIEW_COUNT = 15;
export const SidebarThreadPreviewCount = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_THREAD_PREVIEW_COUNT,
    maximum: MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
  }),
);
export type SidebarThreadPreviewCount = typeof SidebarThreadPreviewCount.Type;
export const DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT: SidebarThreadPreviewCount = 6;

export const ClientSettingsSchema = Schema.Struct({
  autoOpenPlanSidebar: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  diffIgnoreWhitespace: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // Model favorites. Historically keyed by provider kind, now
  // widened to `ProviderInstanceId` so users can favorite a specific model
  // on a custom provider instance (e.g. "Codex Personal · gpt-5") without
  // the UI collapsing it into the same bucket as the default Codex. The
  // widening is backward-compatible by construction: prior provider-kind
  // strings satisfy the `ProviderInstanceId` slug schema, so previously
  // persisted favorites decode unchanged and continue to point at the
  // default instance for their kind (because `defaultInstanceIdForDriver(kind)`
  // uses the same slug). The field name is kept as `provider` for storage
  // stability; new call sites should treat the value as an instance id.
  favorites: Schema.Array(
    Schema.Struct({
      provider: ProviderInstanceId,
      model: TrimmedNonEmptyString,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  providerModelPreferences: Schema.Record(
    ProviderInstanceId,
    Schema.Struct({
      hiddenModels: Schema.Array(Schema.String).pipe(
        Schema.withDecodingDefault(Effect.succeed([])),
      ),
      modelOrder: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sidebarProjectGroupingMode: SidebarProjectGroupingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE)),
  ),
  sidebarProjectGroupingOverrides: Schema.Record(
    TrimmedNonEmptyString,
    SidebarProjectGroupingMode,
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_SORT_ORDER)),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_SORT_ORDER)),
  ),
  sidebarThreadPreviewCount: SidebarThreadPreviewCount.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT)),
  ),
  timestampFormat: TimestampFormat.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TIMESTAMP_FORMAT)),
  ),
  wordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

// ── Server Settings (server-authoritative) ────────────────────

const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );

export type ProviderSettingsFormControl = "text" | "password" | "textarea" | "switch";

export interface ProviderSettingsFormAnnotation {
  readonly control?: ProviderSettingsFormControl | undefined;
  readonly placeholder?: string | undefined;
  readonly hidden?: boolean | undefined;
  readonly clearWhenEmpty?: "omit" | "persist" | undefined;
}

export interface ProviderSettingsFormSchemaAnnotation {
  readonly order?: readonly string[] | undefined;
}

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      readonly providerSettingsForm?: ProviderSettingsFormAnnotation | undefined;
      readonly providerSettingsFormSchema?: ProviderSettingsFormSchemaAnnotation | undefined;
    }
  }
}

export type ProviderSettingsOrder<Fields extends Schema.Struct.Fields> = readonly Extract<
  keyof Fields,
  string
>[];

export function makeProviderSettingsSchema<const Fields extends Schema.Struct.Fields>(
  fields: Fields,
  options?: {
    readonly order?: ProviderSettingsOrder<Fields> | undefined;
  },
): Schema.Struct<Fields> {
  return Schema.Struct(fields).pipe(
    Schema.annotate({
      providerSettingsFormSchema:
        options?.order === undefined ? undefined : { order: options.order },
    }),
  );
}

export const CodexSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("codex").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Codex binary used by this instance.",
        providerSettingsForm: { placeholder: "codex", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CODEX_HOME path",
        description: "Custom Codex home and config directory.",
        providerSettingsForm: {
          placeholder: "~/.codex",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    shadowHomePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Shadow home path",
        description:
          "Account-specific Codex home. Keeps auth.json separate while sharing state from CODEX_HOME.",
        providerSettingsForm: {
          placeholder: "~/.codex-t3/personal",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    launchArgs: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed to codex app-server on session start.",
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "shadowHomePath", "launchArgs"],
  },
);
export type CodexSettings = typeof CodexSettings.Type;

export const ClaudeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("claude").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Claude binary used by this instance.",
        providerSettingsForm: { placeholder: "claude", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CLAUDE_CONFIG_DIR path",
        description:
          "Custom Claude home and config directory. Keeps .claude.json and .claude separate.",
        providerSettingsForm: { placeholder: "~/.claude", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    launchArgs: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed on session start.",
        providerSettingsForm: {
          placeholder: "e.g. --chrome",
          clearWhenEmpty: "omit",
        },
      }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "launchArgs"],
  },
);
export type ClaudeSettings = typeof ClaudeSettings.Type;

export const CursorSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("cursor-agent").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Cursor agent binary.",
        providerSettingsForm: { placeholder: "cursor-agent", clearWhenEmpty: "omit" },
      }),
    ),
    apiEndpoint: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "API endpoint",
        description: "Override the Cursor API endpoint for this instance.",
        providerSettingsForm: {
          placeholder: "https://...",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "apiEndpoint"],
  },
);
export type CursorSettings = typeof CursorSettings.Type;

export const GrokSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("grok").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Grok CLI binary.",
        providerSettingsForm: { placeholder: "grok", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath"],
  },
);
export type GrokSettings = typeof GrokSettings.Type;

export const OpenCodeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("opencode").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the OpenCode binary.",
        providerSettingsForm: {
          placeholder: "opencode",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Server URL",
        description: "Leave blank to let T3 Code spawn the server when needed.",
        providerSettingsForm: {
          placeholder: "http://127.0.0.1:4096",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    serverPassword: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Server password",
        description: "Stored in plain text on disk.",
        providerSettingsForm: {
          control: "password",
          placeholder: "Optional",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "serverUrl", "serverPassword"],
  },
);
export type OpenCodeSettings = typeof OpenCodeSettings.Type;

export const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ObservabilitySettings = typeof ObservabilitySettings.Type;

export const DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL = Duration.seconds(30);

// ── Global skill commands ───────────────────────────────────────

const SKILL_COMMAND_ID_MAX_CHARS = 64;
const SKILL_COMMAND_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const MAX_SKILL_COMMAND_PROMPT_CHARS = 20_000;

/**
 * `SkillCommandId` — the slug a user types after `/` in the composer to
 * invoke a global skill command. Doubles as the command's display name (no
 * separate `name` field) and as the key in `ServerSettings.skillCommands`.
 * Same slug shape as `ProviderDriverKind`/`ProviderInstanceId` (must start
 * with a letter; letters, digits, `-`, `_` after that) so it's always safe
 * to type immediately after a slash.
 */
export const SkillCommandId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(SKILL_COMMAND_ID_MAX_CHARS),
  Schema.isPattern(SKILL_COMMAND_ID_PATTERN),
).pipe(Schema.brand("SkillCommandId"));
export type SkillCommandId = typeof SkillCommandId.Type;

/**
 * A user-authored, static text snippet inserted into the outgoing message
 * when its `/name` token is sent from the composer. Named `GlobalSkillCommand`
 * (not `Skill`) to avoid confusion with the unrelated, provider-sourced
 * `ServerProviderSkill` (filesystem `.claude/skills`-style skills invoked via
 * `$name` and resolved by the CLI agent itself).
 */
export const GlobalSkillCommand = Schema.Struct({
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_SKILL_COMMAND_PROMPT_CHARS)),
});
export type GlobalSkillCommand = typeof GlobalSkillCommand.Type;

/** Hermes transports. Exactly one serves a tick; there is no fallback between them. */
export const HERMES_TIERS = ["cursor", "xai", "codex", "openrouter"] as const;
export const HermesTier = Schema.Literals(HERMES_TIERS);
export type HermesTier = typeof HermesTier.Type;

/** Model the chosen provider is asked for when the user has not set one. */
export const DEFAULT_HERMES_BRAIN_MODEL = "x-ai/grok-4.5";

/**
 * Provider instance that ships with that model — its own, not whichever tier
 * sorts first. The two are a pair: a default that asks the Cursor CLI for
 * `grok-4.5` is a board brain that cannot answer on a box where everything is
 * installed and logged in.
 */
export const DEFAULT_HERMES_BRAIN_INSTANCE_ID = "grok";

/**
 * The review turn the optional review pass sends. Self-contained on purpose —
 * the toggle has to work before any skill or harness command is installed.
 */
export const DEFAULT_HERMES_REVIEW_PROMPT = [
  "Review the change you just made, as a reviewer who did not write it.",
  "",
  "Check it against the card's goal, then for correctness bugs, cases the tests do not cover,",
  "and anything left half-done. Fix what you find, in this worktree.",
  "",
  "Close with DONE: what you verified, and REMAINING: anything you chose not to fix and why.",
].join("\n");

/** Live tier state for the settings panel. Never carries a key, only whether one resolved. */
export const HermesTierStatus = Schema.Struct({
  tier: HermesTier,
  /** True for the one provider Hermes is pointed at. */
  enabled: Schema.Boolean,
  available: Schema.Boolean,
  detail: Schema.String,
  /** Model id as this transport will ask for it (ACP CLIs drop the org prefix). */
  model: Schema.String,
});
export type HermesTierStatus = typeof HermesTierStatus.Type;

/**
 * What one wired-up transport can run: a provider driver's instances, or any
 * model whose slug carries this prefix. The picker reads this so a selection
 * Hermes cannot drive is refused where it is made, instead of failing every
 * tick afterwards with "not a transport Hermes can run".
 */
export const HermesTransportClaim = Schema.Struct({
  tier: HermesTier,
  driver: Schema.NullOr(Schema.String),
  modelPrefix: Schema.NullOr(Schema.String),
});
export type HermesTransportClaim = typeof HermesTransportClaim.Type;

export const HermesBoardCall = Schema.Struct({
  method: Schema.String,
  args: Schema.Unknown,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
  skipped: Schema.optional(Schema.Boolean),
  /** The operation coordinator declined before the call ran, so nothing was tried. */
  refused: Schema.optional(Schema.Boolean),
  /** Wall clock for this call. Absent on ticks written before it was measured. */
  durationMs: Schema.optional(Schema.Number),
});
export type HermesBoardCall = typeof HermesBoardCall.Type;

/**
 * What one Hermes brain call actually cost. Provider-reported, never estimated
 * — an ACP tier that reports nothing leaves this absent rather than guessing,
 * because a guessed number in a cost log is worse than no number.
 */
export const HermesTokenUsage = Schema.Struct({
  inputTokens: Schema.Number,
  /** Subset of `inputTokens` that hit the provider's prompt cache. */
  cachedInputTokens: Schema.Number,
  outputTokens: Schema.Number,
  reasoningTokens: Schema.optional(Schema.Number),
  /** Provider-billed USD. Absent when the tier bills quota instead of dollars. */
  usd: Schema.optional(Schema.Number),
  /** OpenRouter generation id, for looking a tick up on their side. */
  generationId: Schema.optional(Schema.String),
  /** Upstream provider OpenRouter routed to. */
  provider: Schema.optional(Schema.String),
});
export type HermesTokenUsage = typeof HermesTokenUsage.Type;

export const HermesTickAttempt = Schema.Struct({
  tier: HermesTier,
  outcome: Schema.String,
  detail: Schema.String,
  /** Wall clock for this tier, probe included. Absent on older ticks. */
  durationMs: Schema.optional(Schema.Number),
  usage: Schema.optional(HermesTokenUsage),
});
export type HermesTickAttempt = typeof HermesTickAttempt.Type;

/**
 * What a tick spent on the wire and on the clock. `promptChars` is the whole
 * ask (system + snapshot); `snapshotChars` is the part that grows with the
 * board, which is the number to watch when a tick gets expensive.
 */
export const HermesTickCost = Schema.Struct({
  promptChars: Schema.Number,
  snapshotChars: Schema.Number,
  programChars: Schema.Number,
  /** Model calls this tick made — 2 when a bad program bought a retry. */
  modelCalls: Schema.Number,
  /** Time inside the backend chain, retry included. */
  modelMs: Schema.Number,
  /** Time running the program against the board. */
  executionMs: Schema.Number,
  usage: Schema.optional(HermesTokenUsage),
  /** ≈tokens of carried conversation history this tick re-sent. Estimate (chars/4). */
  historyTokens: Schema.optional(Schema.Number),
  /** ≈tokens of the new user turn — the delta, or the first-turn snapshot. */
  deltaTokens: Schema.optional(Schema.Number),
});
export type HermesTickCost = typeof HermesTickCost.Type;

/**
 * What started a tick. `wake` is a board event that could not wait for the
 * interval — a composer send, a card moved into a column Hermes owns.
 */
export const HERMES_TICK_TRIGGERS = ["interval", "wake", "manual"] as const;
export const HermesTickTrigger = Schema.Literals(HERMES_TICK_TRIGGERS);
export type HermesTickTrigger = typeof HermesTickTrigger.Type;

/** One tick, rendered by the Hermes settings tab. */
export const HermesTickTranscript = Schema.Struct({
  id: Schema.String,
  ranAt: Schema.String,
  durationMs: Schema.Number,
  tier: Schema.NullOr(HermesTier),
  model: Schema.String,
  attempts: Schema.Array(HermesTickAttempt),
  program: Schema.NullOr(Schema.String),
  calls: Schema.Array(HermesBoardCall),
  logs: Schema.Array(Schema.String),
  summary: Schema.String,
  error: Schema.NullOr(Schema.String),
  recordOnly: Schema.Boolean,
  /** True when the rules settled the board and no tier was asked. */
  modelSkipped: Schema.optional(Schema.Boolean),
  /** What the deterministic pass did before (or instead of) a model call. */
  ruleActions: Schema.optional(Schema.Number),
  /** Absent on ticks written before triggers were recorded. */
  trigger: Schema.optional(HermesTickTrigger),
  /** The board event that woke the loop, when `trigger` is `wake`. */
  wakeReason: Schema.optional(Schema.String),
  /** Predicted vs actual for budget routing. Absent while routing is off. */
  budget: Schema.optional(HermesTickBudget),
  /** What this tick cost in tokens, dollars and time. */
  cost: Schema.optional(HermesTickCost),
});
export type HermesTickTranscript = typeof HermesTickTranscript.Type;

/**
 * One line in the tick log. Carries counts instead of the program and call
 * payloads so polling the panel stays cheap; the full transcript is fetched
 * per id when a row is expanded.
 */
export const HermesTickLogEntry = Schema.Struct({
  id: Schema.String,
  ranAt: Schema.String,
  durationMs: Schema.Number,
  tier: Schema.NullOr(HermesTier),
  model: Schema.String,
  summary: Schema.String,
  error: Schema.NullOr(Schema.String),
  recordOnly: Schema.Boolean,
  trigger: Schema.optional(HermesTickTrigger),
  wakeReason: Schema.optional(Schema.String),
  callCount: Schema.Number,
  writeCount: Schema.Number,
  modelSkipped: Schema.optional(Schema.Boolean),
  ruleActions: Schema.optional(Schema.Number),
  attempts: Schema.Array(HermesTickAttempt),
  cost: Schema.optional(HermesTickCost),
});
export type HermesTickLogEntry = typeof HermesTickLogEntry.Type;

/**
 * Everything Hermes has spent on itself since the counters were last reset.
 * Durable — the point of a spend number is the trend, and a trend that dies
 * with the process cannot tell you whether last week's change helped.
 */
export const HermesSpend = Schema.Struct({
  inputTokens: Schema.Number,
  cachedInputTokens: Schema.Number,
  outputTokens: Schema.Number,
  usd: Schema.Number,
  /** Model calls whose tier reported usage. The denominator for `usd`. */
  measuredCalls: Schema.Number,
  /** Model calls whose tier reported nothing, so they cost more than `usd` says. */
  unmeasuredCalls: Schema.Number,
  modelMs: Schema.Number,
});
export type HermesSpend = typeof HermesSpend.Type;

/**
 * What one rule has done since the counters were reset. `rule` is the tick
 * log's own rule id (`mergeable-pr`, `pr-conflicts`, …), which is what the
 * rules dialog maps its rows onto.
 */
export const HermesRuleStat = Schema.Struct({
  rule: Schema.String,
  fired: Schema.Number,
  lastFiredAt: Schema.NullOr(Schema.String),
});
export type HermesRuleStat = typeof HermesRuleStat.Type;

/** Counters since `since`. Restored from disk on boot, so a restart is not a reset. */
export const HermesBrainStats = Schema.Struct({
  since: Schema.String,
  heartbeats: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  skipped: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  ticks: Schema.Number,
  failed: Schema.Number,
  writes: Schema.Number,
  nudges: Schema.Number,
  /** Ticks the rules settled with no tier asked. */
  modelSkipped: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** Board writes the deterministic pass made without a model. */
  ruleWrites: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** Per-rule fire counts, so a rule row can say whether it has ever run. */
  rules: Schema.Array(HermesRuleStat).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  servedByTier: Schema.Array(Schema.Struct({ tier: HermesTier, served: Schema.Number })),
  spend: Schema.optional(HermesSpend),
  /** Where the uncapped per-tick usage log lives, for `hermes-tick-stats.mjs`. */
  usageLogPath: Schema.optional(Schema.NullOr(Schema.String)),
});
export type HermesBrainStats = typeof HermesBrainStats.Type;

/**
 * Who a Hermes chat line came from. `board` is the turn the runtime sent —
 * what Hermes was told; `hermes` is what it did with it; `reply` is Hermes
 * answering a question someone typed at it, in full.
 */
export const HERMES_CHAT_KINDS = ["board", "hermes", "note", "reply"] as const;
export const HermesChatKind = Schema.Literals(HERMES_CHAT_KINDS);
export type HermesChatKind = typeof HermesChatKind.Type;

/**
 * One line of the Hermes chat — the loop's own conversation, kept for a reader
 * rather than for a prompt. The conversation the model carries is cut at every
 * decision boundary; this is not, so the panel can still show what happened.
 */
export const HermesChatEntry = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  kind: HermesChatKind,
  /** The collapsed line. Always short enough to read without expanding. */
  summary: Schema.String,
  /** The turn verbatim: the board block Hermes was sent, or what its calls did. */
  text: Schema.String,
  /** The program Hermes wrote this tick, when it wrote one. */
  program: Schema.optional(Schema.String),
  tickId: Schema.optional(Schema.String),
  tier: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type HermesChatEntry = typeof HermesChatEntry.Type;

/** The persisted Hermes conversation, as the settings panel shows it. */
export const HermesConversationStatus = Schema.Struct({
  turns: Schema.Number,
  /** Estimated tokens the whole history costs to re-send (chars/4). */
  estTokens: Schema.Number,
  /** Recorded past calls carried across evictions; the part a re-read cannot recover. */
  journalEntries: Schema.Number,
  lastEvictionAt: Schema.NullOr(Schema.String),
  /** Where the cut landed: a settled board, closed decisions, or the backstop. */
  lastEvictionReason: Schema.NullOr(Schema.Literals(["settled", "resolved", "ceiling"])),
  startedAt: Schema.NullOr(Schema.String),
});
export type HermesConversationStatus = typeof HermesConversationStatus.Type;

/**
 * The box checks Hermes ran before it was willing to spend a tick. `checkId` is
 * the critical check that is still failing after its autofix, or null when the
 * box came back clean.
 */
export const HermesPreflightStatus = Schema.Struct({
  ok: Schema.Boolean,
  at: Schema.String,
  checkId: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
});
export type HermesPreflightStatus = typeof HermesPreflightStatus.Type;

/**
 * One column and every rule it runs, as the board actually built it.
 *
 * The rules dialog renders this rather than a list kept by hand beside the
 * code. If a behavior runs it is here, and if it is not here it does not run —
 * which is the whole reason the rules are a list of values rather than
 * branches inside a pass.
 */
export const HermesComponentRules = Schema.Struct({
  /** The component these rules belong to. */
  at: Schema.String,
  title: Schema.String,
  rules: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      /** The key its fire counter records under; null when it has none. */
      id: Schema.NullOr(Schema.String),
      /** True when a settings row switches it, so the dialog can say so. */
      fromRow: Schema.Boolean,
    }),
  ),
});
export type HermesComponentRules = typeof HermesComponentRules.Type;

export const HermesBrainStatus = Schema.Struct({
  enabled: Schema.Boolean,
  /** The loop is actually ticking (enabled and wired up). */
  running: Schema.Boolean,
  busy: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Provider instance the brain runs on; null until one is picked. */
  instanceId: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Transport the selection resolves to; null when it resolves to none. */
  provider: Schema.NullOr(HermesTier).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Why the selection has no transport, for the panel. Null when it resolved. */
  providerError: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  model: Schema.String,
  intervalMs: Schema.Number,
  maxNudges: Schema.Number,
  nextTickAt: Schema.NullOr(Schema.String),
  lastHeartbeatAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  lastModelAt: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  lastSkipReason: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  tiers: Schema.Array(HermesTierStatus),
  /** What the wired-up transports claim. Empty on servers built before it existed. */
  transports: Schema.Array(HermesTransportClaim).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  lastTick: Schema.NullOr(HermesTickTranscript),
  log: Schema.Array(HermesTickLogEntry),
  /** Where the durable tick log lives on the server; null when unwritable. */
  logPath: Schema.NullOr(Schema.String),
  stats: HermesBrainStats,
  /** Absent on servers built before the conversation existed. */
  conversation: Schema.optional(HermesConversationStatus),
  /** Null until the loop has run its first check pass. */
  preflight: Schema.optional(Schema.NullOr(HermesPreflightStatus)),
  /**
   * What each component runs. Absent on servers built before the components.
   *
   * Named apart from `stats.rules`, which is the fire counters: one says what
   * exists and the other says how often it has happened.
   */
  componentRules: Schema.optional(Schema.Array(HermesComponentRules)),
});
export type HermesBrainStatus = typeof HermesBrainStatus.Type;

/**
 * One roster seat: a model plus the owner's own sentence about what it is for.
 * The note is free text — Hermes and launched threads read it as the rule,
 * which is why there is no fixed role vocabulary here.
 */
export const BoardModelRosterEntry = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  // Untrimmed: the note is prose being typed, and the round trip through this
  // schema must not delete the space at the end of the word you just wrote.
  note: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /**
   * Provider options the rule launches with — reasoning effort, fast mode, and
   * whatever else the model exposes. Same shape as `ModelSelection.options`, so
   * routing hands them straight to the thread.
   */
  options: ProviderOptionSelections.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /**
   * Thinking-effort band the router may pick inside for this seat. Absent =
   * fixed by `options` (or the model default). `min === max` is a pinned
   * level; a wider band lets task size and quota headroom set the level.
   */
  effortRange: Schema.optional(
    Schema.Struct({ min: TrimmedNonEmptyString, max: TrimmedNonEmptyString }),
  ),
});
export type BoardModelRosterEntry = typeof BoardModelRosterEntry.Type;

/**
 * One outbound MCP server the Hermes tick program may call, as
 * `mcp.<name>.<tool>(args)`. Streamable-HTTP transport only.
 *
 * `name` is the namespace the program sees, so it must be a plain JS
 * identifier — the surface generator quotes tool names, never server names.
 */
export const HermesMcpServer = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)),
  /** Empty while a row added from Settings is still being filled in. */
  url: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** Extra request headers, e.g. `Authorization: Bearer …`. */
  headers: Schema.Record(TrimmedNonEmptyString, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type HermesMcpServer = typeof HermesMcpServer.Type;

/**
 * One row of a column's When/Then logic: `{when: "cardArrives", then:
 * "startThread"}`. Verbs are deliberately open strings — the vocabulary lives
 * with whatever executes the rule (web board, Hermes), and a row this build
 * does not understand is kept and skipped, never dropped.
 */
export const BoardRuleRow = Schema.Struct({
  when: TrimmedNonEmptyString,
  then: TrimmedNonEmptyString,
  arg: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type BoardRuleRow = typeof BoardRuleRow.Type;

/** What Fix it does with an error the app caught. */
export const ERROR_FIX_MODES = ["card", "thread"] as const;
export const ErrorFixMode = Schema.Literals(ERROR_FIX_MODES);
export type ErrorFixMode = typeof ErrorFixMode.Type;
export const DEFAULT_ERROR_FIX_MODE: ErrorFixMode = "card";

/**
 * Board + Hermes workflow prefs. Server-authoritative so they survive restarts
 * and stay shared across browsers/origins (not localStorage-only).
 */
export const BoardSettings = Schema.Struct({
  /**
   * Per-column rule rows, keyed by column id. A column with no entry runs its
   * built-in default rules; an entry (even empty) replaces them wholesale.
   */
  rules: Schema.Record(TrimmedNonEmptyString, Schema.Array(BoardRuleRow)).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /**
   * Composer preset: the harness + model every new card is captured with.
   * Null on either half means "Router" — the model-router skill and launch
   * routing pick instead.
   */
  composerInstanceId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  composerModel: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  alwaysOnSkillIds: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(["structure", "model-router"])),
  ),
  autoPromoteDraftAfterSkills: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  confirmBeforeLaunchActive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Fix it on an error files a Prompts card (Hermes routes and launches it) or
   * opens a host thread on the spot. Thread is the escape hatch for when the
   * board itself is what broke.
   */
  errorFixMode: ErrorFixMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ERROR_FIX_MODE)),
  ),
  showHermesChip: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  showUsageIndicator: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  hermesInstanceId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  hermesModel: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  hermesStuckPrepMs: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(120_000))),
  /**
   * How long a card may sit in one column, untouched and with no running turn,
   * before the `cardStalled` rule fires. Only columns with a `cardStalled` row
   * act on it.
   */
  hermesStalledCardMs: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(1_800_000))),
  /** Rolling 24h ceiling on what Hermes may spend on itself. 0 disables it. */
  hermesDailyUsdCap: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  hermesAutoMoveDraftsToPrompts: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  /**
   * Superseded by `rules` — the pipeline policies are rule rows now, and
   * nothing writes these four any more. They are still read, for the one case
   * a row cannot answer: a column saved before its trigger existed.
   * @see packages/shared/src/boardRules.ts `boardRulePolicy`
   */
  hermesAutoApplySkillsToAutoMovedPrompts: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  hermesAutoMovePromptsToActive: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  /**
   * File a Prompts card for a papercut that crossed the recurrence bar. On by
   * default: a papercut that reaches the bar has already been paid for by at
   * least one agent and will be paid for again by every one after it, so
   * leaving it unfiled is not neutral. Prompts, never Active — the owner still
   * decides whether it beats the work already queued.
   */
  hermesAutoDraftPapercuts: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  skillPipelineVersion: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(2))),
  /**
   * Hermes board brain (Grok 4.5, code mode). On by default, together with the
   * three pipeline policies above: a board whose brain is switched off does
   * nothing with what the composer captures, which is not the product.
   */
  hermesBrainEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * Provider instance running the board brain — the same `{instanceId, model}`
   * selection projects and model roles use, with `hermesBrainModel` as the
   * model half. Null means never picked, and the transport is migrated from the
   * legacy chain below, so an upgrade does not silently change providers.
   */
  hermesBrainInstanceId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Legacy fallback chain, kept only so an unpicked brain can migrate from it. */
  hermesBrainTierOrder: Schema.Array(HermesTier).pipe(
    Schema.withDecodingDefault(Effect.succeed([...HERMES_TIERS])),
  ),
  /** Legacy fallback chain, kept only so an unpicked brain can migrate from it. */
  hermesBrainDisabledTiers: Schema.Array(HermesTier).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Model half of the brain's selection. Empty falls back to `DEFAULT_HERMES_BRAIN_MODEL`. */
  hermesBrainModel: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_HERMES_BRAIN_MODEL)),
  ),
  /**
   * Opt-in per-model backstop: model id → the input-token ceiling at which
   * Hermes drops history even though no decision has closed. Absent means no
   * backstop for that model — the history is only ever cut at a boundary, and
   * an overflow is the provider's own compaction to handle. Deliberately not
   * defaulted: a 400k–1M window does not want a number picked for it.
   */
  hermesContextCeilings: Schema.Record(TrimmedNonEmptyString, Schema.Number).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  hermesBrainIntervalMs: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(60_000))),
  hermesBrainMaxNudges: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(3))),
  /**
   * Active → PR without a model call. When a coding thread goes quiet, the
   * rules ask it once whether the card's goal is finished; an answer that
   * still lists work sends it back to finish, and a clean one opens the PR.
   * The question and the answer are turns in the thread, so the whole decision
   * is readable in the chat rather than inferred from a closing message.
   */
  hermesAutoFinishActive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * How many times one Active thread may be asked whether it is done. Not a
   * schedule — a thread that answers "done" is never asked twice. This only
   * bounds the thread that keeps finding one more thing: past it the card stops
   * asking and says it needs a decision.
   */
  hermesCompletionMaxChecks: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(10))),
  /**
   * Merge a card's PR once the forge's checks are green. On by default, which
   * is what the board already did; off leaves green PRs in the PR column.
   */
  hermesAutoMergeWhenGreen: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * How long a pull request with no check runs yet is left alone before the
   * board treats the repo as genuinely checkless and merges it. GitHub Actions
   * registers a workflow run minutes after the PR opens, and the rule pass runs
   * within a minute of it — without this window every PR merged before its own
   * CI existed.
   */
  hermesPrCheckGraceMs: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(600_000))),
  /**
   * One review turn in the coding thread between "the agent says it is done"
   * and the PR. Off by default: it is a second full agent turn per card, and
   * the completion check alone is the cheap path.
   */
  hermesReviewPassEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * What that review turn asks for. Point it at a harness-native review command
   * (`/review`) or a skill once one is installed; the default is self-contained
   * so the toggle works with nothing else set up.
   */
  hermesReviewPrompt: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_HERMES_REVIEW_PROMPT)),
  ),
  /**
   * File a card for each open forge issue no card owns yet, on the orphan
   * sweep's cadence. Off by default: a board that fills itself is a choice.
   */
  hermesWatchIssues: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Only watch issues wearing this forge label (e.g. `hermes`). Empty is every
   * open issue.
   */
  hermesWatchIssuesLabel: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /**
   * Helper threads: ephemeral agent threads Hermes asks a bounded question and
   * reads on a later tick. On by default — a loop that has to read every long
   * transcript itself is the thing they exist to stop.
   */
  hermesHelpersEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Helpers alive at once. Low on purpose: each one is a real agent session. */
  hermesHelperMaxConcurrent: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(2))),
  /** A helper still running past this is abandoned and its card re-queued. */
  hermesHelperTimeoutMs: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(900_000))),
  /**
   * Outbound MCP servers a tick program may call as `mcp.<name>.<tool>`.
   * Empty means the `mcp` namespace is absent from the program surface; a
   * configured server that will not connect is reported as an incident and
   * named as unavailable in the prompt, never quietly dropped.
   */
  hermesMcpServers: Schema.Array(HermesMcpServer).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /**
   * Budget routing (measured cost/quota table decides split, placement and
   * harness). On by default: turn off to route on task size and roster alone.
   */
  hermesBudgetRoutingEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** The one user-facing dial: 0 = cheapest, 100 = fastest. */
  hermesBudgetPosition: Schema.Number.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_HERMES_BUDGET_POSITION)),
  ),
  /**
   * Ordered allowlist of models auto-routing may spend on — the totem pole.
   * Array order is preference order within a role.
   */
  modelRoster: Schema.Array(BoardModelRosterEntry).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /**
   * Restrict auto-routing to `modelRoster`. Off by default so an empty roster
   * never strands a box with no usable model.
   */
  modelRosterEnforced: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Orphan-worktree sweep policy. `T3CODE_WORKTREE_RETENTION_HOURS` /
   * `T3CODE_WORKTREE_REAP_ABANDONED` env vars override these when set.
   */
  worktreeRetentionHours: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(72))),
  worktreeReapAbandoned: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Which pieces of tldraw's chrome the canvas mounts — toolbar tools, style
   * panel swatches, minimap, menus. Defaults to the minimal board; the stock
   * tldraw UI is one preset away in Settings → Board.
   */
  canvasUi: CanvasUiSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_CANVAS_UI_SETTINGS)),
  ),
});
export type BoardSettings = typeof BoardSettings.Type;
export const DEFAULT_BOARD_SETTINGS: BoardSettings = Schema.decodeSync(BoardSettings)({});

export const ServerSettings = Schema.Struct({
  enableAssistantStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  enableProviderUpdateChecks: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  automaticGitFetchInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
    ),
  ),
  newWorktreesStartFromOrigin: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  addProjectBaseDirectory: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("/root/projects")),
  ),
  /**
   * tldraw licence key for the canvas, set from Settings → Board. Empty means
   * the build-time `VITE_TLDRAW_LICENSE_KEY` baked in at deploy is what the
   * canvas runs on. Not a secret: tldraw keys ship inside the client bundle.
   */
  canvasLicenseKey: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /**
   * Author and committer on every commit the board makes, set from
   * Settings → Connections → Version Control. Both halves are required to
   * take effect; empty leaves the box's own git config in charge, which on a
   * VPS with no `user.email` resolves to `root <root@hostname>` and lands as
   * the co-author of every squash-merged pull request.
   */
  commitAuthorName: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  commitAuthorEmail: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
      }),
    ),
  ),
  defaultModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_MODEL,
      }),
    ),
  ),

  // Legacy single-instance-per-driver settings. Continues to be the source
  // of truth until `providerInstances` (below) lands per-driver migration
  // shims and the server starts hydrating instances from it. Driver-specific
  // schemas live here for the duration of the migration; once each driver
  // owns its config in its own package, this struct shrinks to nothing and
  // is removed entirely.
  providers: Schema.Struct({
    codex: CodexSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    claudeAgent: ClaudeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    cursor: CursorSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    grok: GrokSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    opencode: OpenCodeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // New driver-agnostic instance map. Keyed by `ProviderInstanceId`; values
  // are `ProviderInstanceConfig` envelopes. The driver-specific config blob
  // is `Schema.Unknown` at this layer so envelopes with unknown drivers
  // (forks, downgrades, in-flight PR branches) round-trip without loss.
  // See providerInstance.ts for the forward/backward compatibility invariant.
  providerInstances: Schema.Record(ProviderInstanceId, ProviderInstanceConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  // Global skill commands: user-authored `/name` -> prompt-text snippets,
  // expanded into the outgoing message at send time. Server-authoritative
  // (rather than client-local) so the same commands are available from
  // every device/browser hitting this server.
  skillCommands: Schema.Record(SkillCommandId, GlobalSkillCommand).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  // Board + Hermes workflow prefs (server-authoritative across restarts).
  boardSettings: BoardSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

export const ServerSettingsOperation = Schema.Literals([
  "normalize",
  "check-exists",
  "read-file",
  "read-secret",
  "remove-secret",
  "remove-stale-secret",
  "write-secret",
  "write-file",
  "prepare-directory",
]);
export type ServerSettingsOperation = typeof ServerSettingsOperation.Type;

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    operation: ServerSettingsOperation,
    providerInstanceId: Schema.optional(Schema.String),
    environmentVariable: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const provider =
      this.providerInstanceId === undefined ? "" : ` for provider ${this.providerInstanceId}`;
    const variable =
      this.environmentVariable === undefined
        ? ""
        : ` and environment variable ${this.environmentVariable}`;
    return `Server settings ${this.operation} failed${provider}${variable} at ${this.settingsPath}.`;
  }
}

// ── Unified type ─────────────────────────────────────────────────────

export type UnifiedSettings = ServerSettings & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

// ── Server Settings Patch (replace with a Schema.deepPartial if available) ──────────────────────────────────────────

const ModelSelectionPatch = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  options: Schema.optionalKey(ProviderOptionSelections),
});

const CodexSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  homePath: Schema.optionalKey(TrimmedString),
  shadowHomePath: Schema.optionalKey(TrimmedString),
  launchArgs: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ClaudeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  homePath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
  launchArgs: Schema.optionalKey(TrimmedString),
});

const CursorSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  apiEndpoint: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const GrokSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const OpenCodeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  serverUrl: Schema.optionalKey(TrimmedString),
  serverPassword: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const ServerSettingsPatch = Schema.Struct({
  // Server settings
  enableAssistantStreaming: Schema.optionalKey(Schema.Boolean),
  enableProviderUpdateChecks: Schema.optionalKey(Schema.Boolean),
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  newWorktreesStartFromOrigin: Schema.optionalKey(Schema.Boolean),
  addProjectBaseDirectory: Schema.optionalKey(TrimmedString),
  canvasLicenseKey: Schema.optionalKey(TrimmedString),
  commitAuthorName: Schema.optionalKey(TrimmedString),
  commitAuthorEmail: Schema.optionalKey(TrimmedString),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  defaultModelSelection: Schema.optionalKey(ModelSelectionPatch),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(TrimmedString),
      otlpMetricsUrl: Schema.optionalKey(TrimmedString),
    }),
  ),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(CodexSettingsPatch),
      claudeAgent: Schema.optionalKey(ClaudeSettingsPatch),
      cursor: Schema.optionalKey(CursorSettingsPatch),
      grok: Schema.optionalKey(GrokSettingsPatch),
      opencode: Schema.optionalKey(OpenCodeSettingsPatch),
    }),
  ),
  // Whole-map replacement for the new instance config. Patching individual
  // entries is intentionally out of scope: the map is small, and partial
  // patches risk leaving driver-specific config in a half-merged state.
  // The web UI sends a fully-formed map every time it edits this field.
  providerInstances: Schema.optionalKey(Schema.Record(ProviderInstanceId, ProviderInstanceConfig)),
  // Whole-map replacement, same convention as `providerInstances` above.
  skillCommands: Schema.optionalKey(Schema.Record(SkillCommandId, GlobalSkillCommand)),
  // Whole-object replacement for Board + Hermes prefs.
  boardSettings: Schema.optionalKey(BoardSettings),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;

export const ClientSettingsPatch = Schema.Struct({
  autoOpenPlanSidebar: Schema.optionalKey(Schema.Boolean),
  confirmThreadArchive: Schema.optionalKey(Schema.Boolean),
  confirmThreadDelete: Schema.optionalKey(Schema.Boolean),
  diffIgnoreWhitespace: Schema.optionalKey(Schema.Boolean),
  favorites: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        provider: ProviderInstanceId,
        model: TrimmedNonEmptyString,
      }),
    ),
  ),
  providerModelPreferences: Schema.optionalKey(
    Schema.Record(
      ProviderInstanceId,
      Schema.Struct({
        hiddenModels: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefault(Effect.succeed([])),
        ),
        modelOrder: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefault(Effect.succeed([])),
        ),
      }),
    ),
  ),
  sidebarProjectGroupingMode: Schema.optionalKey(SidebarProjectGroupingMode),
  sidebarProjectGroupingOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, SidebarProjectGroupingMode),
  ),
  sidebarProjectSortOrder: Schema.optionalKey(SidebarProjectSortOrder),
  sidebarThreadSortOrder: Schema.optionalKey(SidebarThreadSortOrder),
  sidebarThreadPreviewCount: Schema.optionalKey(SidebarThreadPreviewCount),
  timestampFormat: Schema.optionalKey(TimestampFormat),
  wordWrap: Schema.optionalKey(Schema.Boolean),
});
export type ClientSettingsPatch = typeof ClientSettingsPatch.Type;
