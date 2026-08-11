/**
 * Board settings — localStorage cache + server `settings.json` source of truth.
 * Sync to/from server via `BoardSettingsSync` (bound persist + hydrate).
 */
import {
  CANVAS_COLOR_IDS,
  CANVAS_STYLE_PANEL_MODES,
  CANVAS_TOOL_IDS,
  DEFAULT_BOARD_SETTINGS as CONTRACT_DEFAULT_BOARD_SETTINGS,
  DEFAULT_CANVAS_UI_SETTINGS,
  DEFAULT_ERROR_FIX_MODE,
  ERROR_FIX_MODES,
  HERMES_TIERS,
  type BoardModelRosterEntry,
  type CanvasStylePanelMode,
  type CanvasUiSettings,
  type ErrorFixMode,
  type ProviderOptionSelection,
  type BoardSettings as ContractBoardSettings,
  type HermesTier,
} from "@t3tools/contracts";

import {
  isCoreBoardSkillId,
  mergeCoreBoardSkillIds,
} from "../components/settings/skillCommands/skillCommandsPage.logic";
import { sanitizeRules } from "@t3tools/shared/boardRules";

const STORAGE_KEY = "t3.boardSettings.v1";
const LEGACY_ALWAYS_ON_KEY = "t3.kanban.alwaysOnSkills.v1";
/** Bump when core pipeline membership changes; runs one-time alwaysOn cleanup. */
const SKILL_PIPELINE_VERSION = 2;

export type BoardSettings = ContractBoardSettings;

export const DEFAULT_BOARD_SETTINGS: BoardSettings = {
  ...CONTRACT_DEFAULT_BOARD_SETTINGS,
  alwaysOnSkillIds: mergeCoreBoardSkillIds([...CONTRACT_DEFAULT_BOARD_SETTINGS.alwaysOnSkillIds]),
  skillPipelineVersion: SKILL_PIPELINE_VERSION,
};

type BoardSettingsPersistFn = (settings: BoardSettings) => void;

let persistToServer: BoardSettingsPersistFn | null = null;

/** Register server persist (from BoardSettingsSync). */
export function bindBoardSettingsServerPersist(fn: BoardSettingsPersistFn | null): void {
  persistToServer = fn;
}

function readLegacyAlwaysOn(): ReadonlyArray<string> {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LEGACY_ALWAYS_ON_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

function tierList(value: unknown, fallback: ReadonlyArray<HermesTier>): ReadonlyArray<HermesTier> {
  if (!Array.isArray(value)) return fallback;
  return value.filter((entry): entry is HermesTier =>
    (HERMES_TIERS as ReadonlyArray<string>).includes(entry as string),
  );
}

/** Rules saved before notes existed: keep the seat, phrase its old roles as one. */
const LEGACY_ROLE_NOTE: Record<string, string> = {
  cheap: "small tasks",
  orchestrate: "medium tasks",
  heavy: "large tasks",
  flagship: "hard work nothing else covers",
};

function legacyRoleNote(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const phrases = value
    .map((role) => (typeof role === "string" ? LEGACY_ROLE_NOTE[role] : undefined))
    .filter((phrase): phrase is string => phrase !== undefined);
  return phrases.length === 0 ? "" : `Used for ${[...new Set(phrases)].join(" and ")}.`;
}

/** Provider option selections, last write per id wins. */
function optionList(value: unknown): ReadonlyArray<ProviderOptionSelection> {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, ProviderOptionSelection>();
  for (const raw of value) {
    const option = raw as Partial<ProviderOptionSelection> | null;
    const id = typeof option?.id === "string" ? option.id.trim() : "";
    if (!id) continue;
    const optionValue = option?.value;
    if (typeof optionValue === "boolean") byId.set(id, { id, value: optionValue });
    else if (typeof optionValue === "string" && optionValue.trim().length > 0) {
      byId.set(id, { id, value: optionValue.trim() });
    }
  }
  return [...byId.values()];
}

/** Drop malformed rules and duplicate models; array order is the totem pole. */
function rosterList(value: unknown): ReadonlyArray<BoardModelRosterEntry> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: BoardModelRosterEntry[] = [];
  for (const raw of value) {
    const entry = raw as (Partial<BoardModelRosterEntry> & { roles?: unknown }) | null;
    const instanceId = typeof entry?.instanceId === "string" ? entry.instanceId.trim() : "";
    const model = typeof entry?.model === "string" ? entry.model.trim() : "";
    if (!instanceId || !model) continue;
    const key = `${instanceId}::${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Not trimmed: normalize runs on every keystroke, and trimming here ate the
    // space the moment you typed it, so a rule could never contain one.
    const note = typeof entry?.note === "string" ? entry.note : "";
    const effortRange =
      entry?.effortRange &&
      typeof entry.effortRange.min === "string" &&
      typeof entry.effortRange.max === "string" &&
      entry.effortRange.min.trim() &&
      entry.effortRange.max.trim()
        ? { min: entry.effortRange.min.trim(), max: entry.effortRange.max.trim() }
        : null;
    out.push({
      instanceId,
      model,
      note: note.trim() ? note : legacyRoleNote(entry?.roles),
      options: optionList(entry?.options),
      ...(effortRange ? { effortRange } : {}),
    });
  }
  return out;
}

/** Keep known ids only, deduped, in the canon's own order. */
function canonIds<T extends string>(
  value: unknown,
  canon: ReadonlyArray<T>,
  fallback: ReadonlyArray<T>,
): ReadonlyArray<T> {
  if (!Array.isArray(value)) return fallback;
  const wanted = new Set(value.filter((id): id is T => canon.includes(id as T)));
  return canon.filter((id) => wanted.has(id));
}

function canvasUiSettings(value: unknown): CanvasUiSettings {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<CanvasUiSettings>;
  const tools = canonIds(raw.tools, CANVAS_TOOL_IDS, DEFAULT_CANVAS_UI_SETTINGS.tools);
  const colors = canonIds(raw.colors, CANVAS_COLOR_IDS, DEFAULT_CANVAS_UI_SETTINGS.colors);
  return {
    // A toolbar without select is a trap — nothing can be moved or deleted.
    tools: tools.includes("select") ? tools : ["select", ...tools],
    colors: colors.length > 0 ? colors : DEFAULT_CANVAS_UI_SETTINGS.colors,
    stylePanel: (CANVAS_STYLE_PANEL_MODES as ReadonlyArray<string>).includes(
      raw.stylePanel as string,
    )
      ? (raw.stylePanel as CanvasStylePanelMode)
      : DEFAULT_CANVAS_UI_SETTINGS.stylePanel,
    showMinimap: Boolean(raw.showMinimap),
    showMenus: Boolean(raw.showMenus),
  };
}

function nonEmptyOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const MCP_SERVER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function sanitizeHermesMcpHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value as Record<string, unknown>)) {
    const trimmed = name.trim();
    if (trimmed.length > 0 && typeof headerValue === "string") headers[trimmed] = headerValue;
  }
  return headers;
}

function sanitizeHermesMcpServers(value: unknown): BoardSettings["hermesMcpServers"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const name = nonEmptyOrNull(row.name);
    if (!name || !MCP_SERVER_NAME_PATTERN.test(name)) return [];
    return [
      {
        name,
        // Kept empty on purpose: a row added from Settings has no URL until you
        // type one, and dropping it here made the Add server button a no-op.
        url: typeof row.url === "string" ? row.url.trim() : "",
        headers: sanitizeHermesMcpHeaders(row.headers),
        enabled: row.enabled === undefined ? true : Boolean(row.enabled),
      },
    ];
  });
}

/**
 * Model id → input-token ceiling. Rebuilt rather than passed through: this map
 * is the one board setting whose keys come from outside, and `normalize` is
 * what every read goes through, so anything it drops is `undefined` at every
 * call site — which is how a missing entry here took the whole Hermes panel
 * down on render.
 */
function ceilingMap(value: unknown): Record<string, number> {
  if (value === null || typeof value !== "object") return {};
  const out: Record<string, number> = {};
  for (const [model, raw] of Object.entries(value as Record<string, unknown>)) {
    const tokens = Number(raw);
    if (model.trim().length > 0 && Number.isFinite(tokens) && tokens > 0) {
      out[model.trim()] = Math.floor(tokens);
    }
  }
  return out;
}

function normalize(partial: Partial<BoardSettings> | null | undefined): BoardSettings {
  const base = { ...DEFAULT_BOARD_SETTINGS, ...partial };
  // `rules` was `columnRules` until a card stopped sitting "in a column". A
  // board saved before the rename carries only the old key; one written since
  // carries the new one, and the new one wins where both are present.
  // An empty `rules` is what the defaults contribute, so it does not mean the
  // board has none — a board saved before the rename has its rows under the old
  // key and the default empty object under the new one. Rows win over no rows.
  const legacyRules = (partial as { readonly columnRules?: unknown } | null | undefined)
    ?.columnRules;
  const savedRules =
    partial?.rules !== undefined && Object.keys(partial.rules).length > 0
      ? partial.rules
      : (legacyRules ?? partial?.rules ?? base.rules);
  const priorVersion =
    typeof (partial as { skillPipelineVersion?: unknown } | null | undefined)
      ?.skillPipelineVersion === "number"
      ? (partial as { skillPipelineVersion: number }).skillPipelineVersion
      : 0;
  let rawIds = Array.isArray(base.alwaysOnSkillIds) ? [...base.alwaysOnSkillIds] : [];
  // v2: implement left the core pipeline — drop it once so it doesn't keep
  // running for installs that inherited the old default always-on list.
  if (priorVersion < 2) {
    rawIds = rawIds.filter((id) => id !== "implement");
  }
  // Core skills always lead; optional always-on follow (deduped, order preserved).
  const skills = mergeCoreBoardSkillIds(rawIds);
  return {
    rules: sanitizeRules(savedRules),
    composerInstanceId: nonEmptyOrNull(base.composerInstanceId),
    composerModel: nonEmptyOrNull(base.composerModel),
    alwaysOnSkillIds: skills,
    autoPromoteDraftAfterSkills: Boolean(base.autoPromoteDraftAfterSkills),
    confirmBeforeLaunchActive: Boolean(base.confirmBeforeLaunchActive),
    errorFixMode: (ERROR_FIX_MODES as ReadonlyArray<string>).includes(base.errorFixMode as string)
      ? (base.errorFixMode as ErrorFixMode)
      : DEFAULT_ERROR_FIX_MODE,
    showHermesChip: Boolean(base.showHermesChip),
    showUsageIndicator: Boolean(base.showUsageIndicator),
    hermesInstanceId:
      typeof base.hermesInstanceId === "string" && base.hermesInstanceId.length > 0
        ? base.hermesInstanceId
        : null,
    hermesModel:
      typeof base.hermesModel === "string" && base.hermesModel.length > 0 ? base.hermesModel : null,
    hermesMcpServers: sanitizeHermesMcpServers(base.hermesMcpServers),
    hermesStuckPrepMs: (() => {
      const n = Number(base.hermesStuckPrepMs);
      if (!Number.isFinite(n)) return DEFAULT_BOARD_SETTINGS.hermesStuckPrepMs;
      return Math.max(30_000, Math.floor(n));
    })(),
    hermesStalledCardMs: (() => {
      const n = Number(base.hermesStalledCardMs);
      if (!Number.isFinite(n)) return DEFAULT_BOARD_SETTINGS.hermesStalledCardMs;
      return Math.max(300_000, Math.floor(n));
    })(),
    hermesDailyUsdCap: (() => {
      const n = Number(base.hermesDailyUsdCap);
      if (!Number.isFinite(n) || n < 0) return DEFAULT_BOARD_SETTINGS.hermesDailyUsdCap;
      return n;
    })(),
    hermesAutoMoveDraftsToPrompts: Boolean(base.hermesAutoMoveDraftsToPrompts),
    hermesAutoApplySkillsToAutoMovedPrompts: Boolean(base.hermesAutoApplySkillsToAutoMovedPrompts),
    hermesAutoMovePromptsToActive: Boolean(base.hermesAutoMovePromptsToActive),
    hermesAutoFinishActive: Boolean(base.hermesAutoFinishActive),
    hermesCompletionMaxChecks: (() => {
      const n = Number(base.hermesCompletionMaxChecks);
      if (!Number.isFinite(n)) return DEFAULT_BOARD_SETTINGS.hermesCompletionMaxChecks;
      return Math.max(1, Math.floor(n));
    })(),
    hermesAutoMergeWhenGreen: Boolean(base.hermesAutoMergeWhenGreen),
    hermesPrCheckGraceMs: (() => {
      const n = Number(base.hermesPrCheckGraceMs);
      if (!Number.isFinite(n)) return DEFAULT_BOARD_SETTINGS.hermesPrCheckGraceMs;
      return Math.max(0, Math.floor(n));
    })(),
    hermesReviewPassEnabled: Boolean(base.hermesReviewPassEnabled),
    hermesReviewPrompt:
      typeof base.hermesReviewPrompt === "string" && base.hermesReviewPrompt.trim().length > 0
        ? base.hermesReviewPrompt
        : DEFAULT_BOARD_SETTINGS.hermesReviewPrompt,
    hermesWatchIssues: Boolean(base.hermesWatchIssues),
    hermesWatchIssuesLabel:
      typeof base.hermesWatchIssuesLabel === "string" ? base.hermesWatchIssuesLabel.trim() : "",
    hermesAutoDraftPapercuts: Boolean(base.hermesAutoDraftPapercuts),
    skillPipelineVersion: SKILL_PIPELINE_VERSION,
    // Server-authoritative; the panel writes these through /api/hermes/brain.
    hermesBrainEnabled: Boolean(base.hermesBrainEnabled),
    hermesBrainInstanceId:
      typeof base.hermesBrainInstanceId === "string" && base.hermesBrainInstanceId.trim().length > 0
        ? base.hermesBrainInstanceId.trim()
        : null,
    hermesBrainTierOrder: tierList(base.hermesBrainTierOrder, [...HERMES_TIERS]),
    hermesBrainDisabledTiers: tierList(base.hermesBrainDisabledTiers, []),
    hermesBrainModel:
      typeof base.hermesBrainModel === "string" && base.hermesBrainModel.trim().length > 0
        ? base.hermesBrainModel.trim()
        : DEFAULT_BOARD_SETTINGS.hermesBrainModel,
    hermesBrainIntervalMs: (() => {
      const n = Number(base.hermesBrainIntervalMs);
      if (!Number.isFinite(n)) return DEFAULT_BOARD_SETTINGS.hermesBrainIntervalMs;
      return Math.max(10_000, Math.floor(n));
    })(),
    hermesBrainMaxNudges: (() => {
      const n = Number(base.hermesBrainMaxNudges);
      if (!Number.isFinite(n)) return DEFAULT_BOARD_SETTINGS.hermesBrainMaxNudges;
      return Math.max(0, Math.floor(n));
    })(),
    // Server-authoritative: helpers are the brain's own delegation, not a board pref.
    hermesHelpersEnabled: Boolean(base.hermesHelpersEnabled),
    hermesHelperMaxConcurrent: (() => {
      const n = Number(base.hermesHelperMaxConcurrent);
      if (!Number.isFinite(n)) return DEFAULT_BOARD_SETTINGS.hermesHelperMaxConcurrent;
      return Math.max(0, Math.floor(n));
    })(),
    hermesHelperTimeoutMs: (() => {
      const n = Number(base.hermesHelperTimeoutMs);
      if (!Number.isFinite(n)) return DEFAULT_BOARD_SETTINGS.hermesHelperTimeoutMs;
      return Math.max(60_000, Math.floor(n));
    })(),
    // Server-authoritative; the Hermes panel writes these through /api/hermes/budget.
    hermesBudgetRoutingEnabled: Boolean(base.hermesBudgetRoutingEnabled),
    hermesBudgetPosition: (() => {
      const n = Number(base.hermesBudgetPosition);
      if (!Number.isFinite(n)) return DEFAULT_BOARD_SETTINGS.hermesBudgetPosition;
      return Math.max(0, Math.min(100, Math.round(n)));
    })(),
    hermesContextCeilings: ceilingMap(base.hermesContextCeilings),
    modelRoster: rosterList(base.modelRoster),
    modelRosterEnforced: Boolean(base.modelRosterEnforced),
    worktreeRetentionHours: (() => {
      const n = Number(base.worktreeRetentionHours);
      if (!Number.isFinite(n) || n <= 0) return DEFAULT_BOARD_SETTINGS.worktreeRetentionHours;
      return n;
    })(),
    worktreeReapAbandoned: Boolean(base.worktreeReapAbandoned),
    canvasUi: canvasUiSettings(base.canvasUi),
  };
}

function hasLocalStorageBoardSettings(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(STORAGE_KEY) !== null;
}

/**
 * Value equality, not key order. `JSON.stringify` compares insertion order, and
 * the two objects fed to this never share one: `normalize()` builds its result
 * as a literal, `DEFAULT_BOARD_SETTINGS` spreads the contract's. So
 * `serverIsDefault` was always false and the local → server migration in
 * `hydrateBoardSettingsFromServer` never ran once.
 */
function boardSettingsEqual(a: BoardSettings, b: BoardSettings): boolean {
  return stableJson(a) === stableJson(b);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, raw: unknown) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const entries = Object.entries(raw as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return Object.fromEntries(entries);
  });
}

/** Read raw localStorage without migrating (for server hydrate decisions). */
export function peekLocalBoardSettings(): BoardSettings | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalize(JSON.parse(raw) as Partial<BoardSettings>);
  } catch {
    return null;
  }
}

export function readBoardSettings(): BoardSettings {
  if (typeof window === "undefined") return DEFAULT_BOARD_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const legacy = readLegacyAlwaysOn();
      if (legacy.length === 0) return DEFAULT_BOARD_SETTINGS;
      const migrated = normalize({ alwaysOnSkillIds: legacy });
      writeBoardSettings(migrated, { persistRemote: false });
      return migrated;
    }
    const parsed = JSON.parse(raw) as Partial<BoardSettings>;
    const priorVersion =
      typeof parsed.skillPipelineVersion === "number" ? parsed.skillPipelineVersion : 0;
    const next = normalize(parsed);
    // Persist pipeline migrations (e.g. drop former-core implement) once.
    if (priorVersion < SKILL_PIPELINE_VERSION) {
      writeBoardSettings(next, { persistRemote: false });
      return next;
    }
    // One-time merge legacy skills if v1 had none.
    if (next.alwaysOnSkillIds.length === 0) {
      const legacy = readLegacyAlwaysOn();
      if (legacy.length > 0) {
        const merged = normalize({ ...next, alwaysOnSkillIds: legacy });
        writeBoardSettings(merged, { persistRemote: false });
        return merged;
      }
    }
    return next;
  } catch {
    return DEFAULT_BOARD_SETTINGS;
  }
}

export function writeBoardSettings(
  settings: BoardSettings,
  options?: { readonly persistRemote?: boolean },
): void {
  if (typeof window === "undefined") return;
  const next = normalize(settings);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  // Keep legacy key in sync so older readers don't diverge mid-session.
  window.localStorage.setItem(LEGACY_ALWAYS_ON_KEY, JSON.stringify(next.alwaysOnSkillIds));
  window.dispatchEvent(new CustomEvent("t3.boardSettings.changed", { detail: next }));
  if (options?.persistRemote !== false) {
    queueRemotePersist(next);
  }
}

/**
 * Coalesce remote writes and remember the newest one we sent.
 *
 * A text field in board settings writes on every keystroke. Un-debounced that
 * is one RPC per character, and each one echoes back through
 * `applyServerBoardSettings` a few keystrokes late — which used to overwrite
 * the field with the word as it looked before, dropping roughly every other
 * character the owner typed.
 */
const REMOTE_PERSIST_DEBOUNCE_MS = 250;
/** How long a local write outranks a server echo that disagrees with it. */
const REMOTE_ECHO_GRACE_MS = 5_000;

let pendingRemote: {
  readonly settings: BoardSettings;
  readonly atMs: number;
  sent: boolean;
} | null = null;
let remotePersistTimer: ReturnType<typeof setTimeout> | null = null;

function queueRemotePersist(next: BoardSettings): void {
  pendingRemote = { settings: next, atMs: Date.now(), sent: false };
  if (remotePersistTimer !== null) clearTimeout(remotePersistTimer);
  remotePersistTimer = setTimeout(flushRemotePersist, REMOTE_PERSIST_DEBOUNCE_MS);
}

/** Send the queued write now. Exported for teardown paths that can't wait. */
export function flushRemotePersist(): void {
  if (remotePersistTimer !== null) {
    clearTimeout(remotePersistTimer);
    remotePersistTimer = null;
  }
  if (!pendingRemote || pendingRemote.sent) return;
  pendingRemote.sent = true;
  persistToServer?.(pendingRemote.settings);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushRemotePersist);
}

export function __resetBoardSettingsRemoteQueueForTests(): void {
  if (remotePersistTimer !== null) clearTimeout(remotePersistTimer);
  remotePersistTimer = null;
  pendingRemote = null;
}

export function updateBoardSettings(patch: Partial<BoardSettings>): BoardSettings {
  const next = normalize({ ...readBoardSettings(), ...patch });
  writeBoardSettings(next);
  return next;
}

export function resetBoardSettings(): BoardSettings {
  writeBoardSettings(DEFAULT_BOARD_SETTINGS);
  return DEFAULT_BOARD_SETTINGS;
}

/**
 * Apply server board settings into the local cache.
 * If local has prefs and server is still defaults, migrate local → server once.
 */
export function hydrateBoardSettingsFromServer(serverBoard: BoardSettings): BoardSettings {
  const normalizedServer = normalize(serverBoard);
  const local = peekLocalBoardSettings();
  const serverIsDefault = boardSettingsEqual(normalizedServer, DEFAULT_BOARD_SETTINGS);

  if (
    local &&
    hasLocalStorageBoardSettings() &&
    serverIsDefault &&
    !boardSettingsEqual(local, DEFAULT_BOARD_SETTINGS)
  ) {
    // One-time migrate browser-local prefs into settings.json.
    writeBoardSettings(local, { persistRemote: true });
    return local;
  }

  return applyServerBoardSettings(normalizedServer);
}

/**
 * Fold the `/api/hermes/brain` answer into the local cache, local-only.
 *
 * Those keys are server-authoritative but they still ride along in every
 * whole-object board write. Without this, toggling a pipeline row right after
 * the brain switch would post a stale `hermesBrainEnabled` back over it.
 */
export function applyServerHermesBrainConfig(config: {
  readonly enabled: boolean;
  readonly instanceId: string | null;
  readonly model: string;
  readonly intervalMs: number;
  readonly maxNudges: number;
}): BoardSettings {
  const next = normalize({
    ...readBoardSettings(),
    hermesBrainEnabled: config.enabled,
    hermesBrainInstanceId: config.instanceId,
    hermesBrainModel: config.model,
    hermesBrainIntervalMs: config.intervalMs,
    hermesBrainMaxNudges: config.maxNudges,
  });
  writeBoardSettings(next, { persistRemote: false });
  return next;
}

/**
 * Fold the `/api/hermes/budget` answer into the local cache, local-only —
 * same contract as {@link applyServerHermesBrainConfig}: these keys are
 * server-authoritative but ride along in whole-object board writes, so a
 * stale local copy would post back over the budget endpoint's truth.
 */
export function applyServerHermesBudgetConfig(config: {
  readonly enabled: boolean;
  readonly position: number;
}): BoardSettings {
  const next = normalize({
    ...readBoardSettings(),
    hermesBudgetRoutingEnabled: config.enabled,
    hermesBudgetPosition: config.position,
  });
  writeBoardSettings(next, { persistRemote: false });
  return next;
}

/** Overwrite local cache from server without writing back (post-hydrate updates). */
export function applyServerBoardSettings(serverBoard: BoardSettings): BoardSettings {
  const normalized = normalize(serverBoard);
  const pending = pendingRemote;
  if (pending) {
    if (boardSettingsEqual(normalized, pending.settings)) {
      pendingRemote = null;
    } else if (Date.now() - pending.atMs < REMOTE_ECHO_GRACE_MS) {
      // The server has not caught up with what we just typed; its answer is the
      // older value, and applying it would undo the keystroke.
      return readBoardSettings();
    }
  }
  writeBoardSettings(normalized, { persistRemote: false });
  return normalized;
}

/** Subscribe to settings changes (same tab + storage events). */
export function subscribeBoardSettings(listener: (settings: BoardSettings) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onCustom = (event: Event) => {
    const detail = (event as CustomEvent<BoardSettings>).detail;
    listener(detail ? normalize(detail) : readBoardSettings());
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === LEGACY_ALWAYS_ON_KEY) {
      listener(readBoardSettings());
    }
  };
  window.addEventListener("t3.boardSettings.changed", onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("t3.boardSettings.changed", onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

// --- Compat for existing always-on helpers ---

export function readAlwaysOnSkillIds(): ReadonlyArray<string> {
  return readBoardSettings().alwaysOnSkillIds;
}

export function writeAlwaysOnSkillIds(ids: ReadonlyArray<string>): void {
  updateBoardSettings({ alwaysOnSkillIds: ids });
}

export function toggleAlwaysOnSkillId(id: string, enabled: boolean): ReadonlyArray<string> {
  const current = [...readAlwaysOnSkillIds()];
  if (enabled) {
    if (!current.includes(id)) current.push(id);
  } else if (isCoreBoardSkillId(id)) {
    return mergeCoreBoardSkillIds(current);
  } else {
    updateBoardSettings({ alwaysOnSkillIds: current.filter((entry) => entry !== id) });
    return readAlwaysOnSkillIds();
  }
  updateBoardSettings({ alwaysOnSkillIds: current });
  return readAlwaysOnSkillIds();
}
