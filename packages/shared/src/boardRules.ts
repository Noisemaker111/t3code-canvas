import type { BoardRuleRow, BoardSettings, ComponentId } from "@t3tools/contracts";

/**
 * Column logic as data — the When/Then rows behind each column's gear.
 *
 * The board used to hardcode what dropping a card on a column does (Active
 * launches, PR opens, Done merges). Those behaviors are now rule rows stored
 * in `boardSettings.rules` and resolved here; the built-in defaults
 * express exactly what the board always did, so an untouched board is
 * unchanged. Verbs are open strings in the contract — a row this build does
 * not know is kept in settings and skipped at dispatch.
 *
 * Which columns exist is not settings at all: a column is a panel on the
 * canvas. A `moveTo` names an id and nothing here checks it against a list,
 * because there is no list — the board draws a column for every id its cards
 * are sitting in.
 *
 * `cardArrives` is the client's — it is what a drop does. Every other trigger
 * is the Hermes tick's: the rule pass reads these rows itself
 * (`ruleEnabled`) rather than the flags they used to be dual-written to.
 * The flags are still read, but only to answer a board saved before its column
 * had rows — see `ruleEnabled`.
 *
 * @module boardRules
 */

export const TRIGGERS = [
  "cardArrives",
  "skillsApplied",
  "hermesNextBestTime",
  "cardDone",
  "checksGreen",
  "cardStalled",
  "prConflict",
] as const;
export type RuleTrigger = (typeof TRIGGERS)[number];

export const ACTIONS = [
  "moveHere",
  "startThread",
  "openPr",
  "mergePr",
  "moveTo",
  "applySkills",
  "display",
] as const;
export type RuleVerb = (typeof ACTIONS)[number];

/**
 * What a drop dispatches. `display` is a `cardArrives` row too, but it says
 * how the column draws its cards, not what arriving does — so the arrival
 * resolver skips it and a column can hold both rows.
 */
const ARRIVAL_ACTIONS: ReadonlySet<string> = new Set([
  "moveHere",
  "startThread",
  "openPr",
  "mergePr",
  "moveTo",
]);

/**
 * A card face is a name, not a member of a union.
 *
 * The faces this build draws are the keys of the registry in
 * `components/kanban/CardTileView.tsx` — adding one is exporting a component
 * and registering it, not editing a list here and then editing three more
 * places that switch on it. A name nothing is registered under draws the board
 * tile, and the row that asked for it survives in settings for whatever wrote
 * it.
 */
export type CardRenderer = string;

/** The face a column draws when it has not asked for one. */
export const DEFAULT_CARD_RENDERER = "default";

export const TRIGGER_LABELS: Record<string, string> = {
  cardArrives: "a card arrives",
  skillsApplied: "skills applied",
  hermesNextBestTime: "Hermes next best time",
  cardDone: "the coding thread finishes",
  checksGreen: "PR checks go green",
  cardStalled: "the card sits here untouched",
  prConflict: "the base branch conflicts",
};

export const ACTION_LABELS: Record<string, string> = {
  moveHere: "just move it here",
  startThread: "start a coding thread",
  openPr: "open the pull request",
  mergePr: "merge the pull request",
  moveTo: "move to…",
  applySkills: "apply prompt skills",
  display: "display cards as…",
};

/** What the board always did, as rows. An untouched board behaves identically. */
export const DEFAULT_RULES: Readonly<Record<string, ReadonlyArray<BoardRuleRow>>> = {
  prompts: [
    { when: "cardArrives", then: "moveHere", arg: "" },
    { when: "hermesNextBestTime", then: "applySkills", arg: "" },
    { when: "skillsApplied", then: "moveTo", arg: "active" },
  ],
  active: [
    { when: "cardArrives", then: "startThread", arg: "" },
    { when: "cardDone", then: "openPr", arg: "" },
  ],
  pr: [
    { when: "cardArrives", then: "openPr", arg: "" },
    { when: "checksGreen", then: "mergePr", arg: "" },
    { when: "prConflict", then: "moveTo", arg: "active" },
  ],
  done: [{ when: "cardArrives", then: "mergePr", arg: "" }],
};

/**
 * What a column with no defaults of its own does when a card lands on it: hold
 * it. A column somebody added is a place to put cards until they give it rows.
 */
export const PLAIN_RULES: ReadonlyArray<BoardRuleRow> = [
  { when: "cardArrives", then: "moveHere", arg: "" },
];

/** The rows a column runs: its stored entry, else its built-in defaults. */
export function rulesFor(
  settings: Pick<BoardSettings, "rules">,
  column: ComponentId,
): ReadonlyArray<BoardRuleRow> {
  return settings.rules[column] ?? defaultRules(column);
}

/** The rows a column runs before anybody edits it. */
export function defaultRules(column: ComponentId): ReadonlyArray<BoardRuleRow> {
  return DEFAULT_RULES[column] ?? PLAIN_RULES;
}

/**
 * The face this column draws its cards with: its `cardArrives → display` row,
 * else the board tile. Whether this build has that face is the registry's
 * question, asked where the faces are — see `CardView`.
 */
export function cardRendererFor(
  settings: Pick<BoardSettings, "rules">,
  column: ComponentId,
): CardRenderer {
  const arg = rulesFor(settings, column).find(
    (rule) => rule.when === "cardArrives" && rule.then === "display",
  )?.arg;
  return arg === undefined || arg.length === 0 ? DEFAULT_CARD_RENDERER : arg;
}

export function isKnownRule(rule: BoardRuleRow): boolean {
  return (
    (TRIGGERS as ReadonlyArray<string>).includes(rule.when) &&
    (ACTIONS as ReadonlyArray<string>).includes(rule.then)
  );
}

/**
 * The rule id a row fires as in the Hermes tick log, so the counters the tick
 * records line up with the rows the dialog shows. Null for a row no
 * server-side rule dispatches (`cardArrives` is the client's drop handler,
 * `hermesNextBestTime` is judgment, not a rule).
 */
export const RULE_ID_BY_ROW: Readonly<Record<string, string>> = {
  "skillsApplied:moveTo": "ready-prompt",
  "cardDone:openPr": "finish-active",
  "checksGreen:mergePr": "mergeable-pr",
  "prConflict:moveTo": "pr-conflicts",
  "cardStalled:moveTo": "card-stalled",
};

export function ruleIdForRow(rule: BoardRuleRow): string | null {
  return RULE_ID_BY_ROW[`${rule.when}:${rule.then}`] ?? null;
}

/** A column's stored rows, or null when it has never been saved. */
function storedRules(
  settings: Pick<BoardSettings, "rules">,
  column: ComponentId,
): ReadonlyArray<BoardRuleRow> | null {
  const all = settings.rules as Record<string, ReadonlyArray<BoardRuleRow> | undefined> | undefined;
  return all?.[column] ?? null;
}

/**
 * Does this column run `when → then`? The stored rows are the answer.
 *
 * `legacy` is the flag the row used to be dual-written to, and it answers
 * exactly one case: a board whose column was saved before this trigger
 * existed, so no row for it can be there to read. A stored row set that does
 * mention the trigger is authoritative in both directions — dropping the row
 * turns the behavior off.
 */
export function ruleEnabled(input: {
  readonly settings: Pick<BoardSettings, "rules">;
  readonly at: ComponentId;
  readonly when: string;
  readonly then: string;
  readonly arg?: string;
  readonly legacy: boolean;
}): boolean {
  const stored = storedRules(input.settings, input.at);
  if (stored === null) return input.legacy;
  if (hasRule(stored, input.when, input.then, input.arg)) return true;
  return stored.some((rule) => rule.when === input.when) ? false : input.legacy;
}

/** Where a `when → moveTo` row points, or null when the column has no such row. */
export function ruleTarget(
  settings: Pick<BoardSettings, "rules">,
  column: ComponentId,
  when: string,
): ComponentId | null {
  const rules = storedRules(settings, column) ?? defaultRules(column);
  const target = rules.find((rule) => rule.when === when && rule.then === "moveTo")?.arg;
  return target === undefined || target.length === 0 ? null : target;
}

/**
 * Rows for `when` this build's rule pass cannot dispatch. A row with a known
 * trigger and an action the pass does not implement is a rule the owner wrote
 * and the board silently ignores — the tick log names it instead.
 */
export function unsupportedRuleRows(
  settings: Pick<BoardSettings, "rules">,
  column: ComponentId,
  when: string,
  supported: ReadonlyArray<string>,
): ReadonlyArray<BoardRuleRow> {
  const rules = storedRules(settings, column) ?? defaultRules(column);
  return rules.filter((rule) => rule.when === when && !supported.includes(rule.then));
}

/** What dropping (or moving) a card onto a column does. */
export type ArrivalAction =
  | { readonly kind: "move"; readonly at: ComponentId }
  | { readonly kind: "startThread"; readonly at: ComponentId }
  | { readonly kind: "openPr"; readonly at: ComponentId }
  | { readonly kind: "mergePr"; readonly at: ComponentId };

/** The slice of the arriving card `resolveArrival` reads to adopt a PR. */
export type ArrivingCard = {
  readonly prUrl?: string | null;
  readonly threadId?: string | null;
};

/**
 * Resolve a column's `cardArrives` rule, following `moveTo` redirects with a
 * visited set — a rule cycle degrades to a plain move onto the last column
 * rather than looping.
 *
 * A card that already has a pull request and no thread behind it — one filed
 * from a PR dragged off a review panel — is adopted, not reopened: `openPr`
 * has nothing to push, so the arrival degrades to a move and the PR column's
 * tick machinery (checks, sync, merge) takes the existing PR from there. A
 * card with a thread keeps `openPr`, which pushes the thread's latest work.
 */
export function resolveArrival(
  settings: Pick<BoardSettings, "rules">,
  target: ComponentId,
  card?: ArrivingCard,
): ArrivalAction {
  const adoptPr = Boolean(card?.prUrl) && !card?.threadId;
  const visited = new Set<ComponentId>();
  let column = target;
  for (;;) {
    visited.add(column);
    const rule = rulesFor(settings, column).find(
      (entry) => entry.when === "cardArrives" && ARRIVAL_ACTIONS.has(entry.then),
    );
    switch (rule?.then) {
      case "startThread":
        return { kind: "startThread", at: column };
      case "openPr":
        return adoptPr ? { kind: "move", at: column } : { kind: "openPr", at: column };
      case "mergePr":
        return { kind: "mergePr", at: column };
      case "moveTo": {
        const next = rule.arg;
        if (next.length === 0 || visited.has(next)) {
          return { kind: "move", at: column };
        }
        column = next;
        continue;
      }
      default:
        return { kind: "move", at: column };
    }
  }
}

function hasRule(
  rules: ReadonlyArray<BoardRuleRow>,
  when: string,
  then: string,
  arg?: string,
): boolean {
  return rules.some(
    (rule) => rule.when === when && rule.then === then && (arg === undefined || rule.arg === arg),
  );
}

/**
 * The settings patch for saving one column's rules. Rows are the only thing
 * written: the brain reads them, so mirroring each one into the automation flag
 * it used to stand for would give the same behavior two writers and let them
 * disagree. The flags survive as the answer for a column saved before its
 * trigger existed — read, never written.
 */
export function rulesPatch(
  settings: Pick<BoardSettings, "rules">,
  column: ComponentId,
  rules: ReadonlyArray<BoardRuleRow>,
): Partial<BoardSettings> {
  return { rules: { ...settings.rules, [column]: rules } };
}

/** The four pipeline policies, as the row that expresses each one. */
export const HERMES_PIPELINE_ROWS = {
  structureDrafts: {
    column: "prompts",
    when: "hermesNextBestTime",
    then: "applySkills",
    arg: "",
  },
  launchPrompts: { column: "prompts", when: "skillsApplied", then: "moveTo", arg: "active" },
  finishActive: { column: "active", when: "cardDone", then: "openPr", arg: "" },
  mergeWhenGreen: { column: "pr", when: "checksGreen", then: "mergePr", arg: "" },
} as const satisfies Record<
  string,
  { column: ComponentId; when: string; then: string; arg: string }
>;

export type HermesPipelineKey = keyof typeof HERMES_PIPELINE_ROWS;

/**
 * Every server-side policy the rule rows now own, resolved once. Settings →
 * Hermes and the rules dialog edit the same rows, so this is the single answer
 * both the tick and the panel read.
 */
export type BoardRulePolicy = {
  readonly structureDrafts: boolean;
  readonly launchPrompts: boolean;
  readonly finishActive: boolean;
  readonly mergeWhenGreen: boolean;
  /** A base branch that collided sends the card back to its thread. */
  readonly conflictReturn: boolean;
};

const LEGACY_FLAG: Record<HermesPipelineKey, keyof BoardSettings> = {
  structureDrafts: "hermesAutoApplySkillsToAutoMovedPrompts",
  launchPrompts: "hermesAutoMovePromptsToActive",
  finishActive: "hermesAutoFinishActive",
  mergeWhenGreen: "hermesAutoMergeWhenGreen",
};

export function boardRulePolicy(settings: BoardSettings): BoardRulePolicy {
  const resolve = (key: HermesPipelineKey): boolean => {
    const row = HERMES_PIPELINE_ROWS[key];
    return ruleEnabled({
      settings,
      at: row.column,
      when: row.when,
      then: row.then,
      arg: row.arg,
      legacy: settings[LEGACY_FLAG[key]] === true,
    });
  };
  return {
    structureDrafts: resolve("structureDrafts"),
    launchPrompts: resolve("launchPrompts"),
    finishActive: resolve("finishActive"),
    mergeWhenGreen: resolve("mergeWhenGreen"),
    // Conflict recovery predates its row, and a board that never gets its card
    // back from a collided base is broken rather than configured — so a column
    // saved before the trigger existed keeps it.
    conflictReturn: ruleEnabled({
      settings,
      at: "pr",
      when: "prConflict",
      then: "moveTo",
      legacy: true,
    }),
  };
}

/**
 * The rows a column really runs. Identical to `rules` once a column has
 * been saved; for one that never has, the built-in defaults minus whatever its
 * legacy flag says is off — otherwise the first edit to an unsaved column would
 * silently switch a policy back on by writing the default row for it.
 */
export function effectiveRules(
  settings: BoardSettings,
  column: ComponentId,
): ReadonlyArray<BoardRuleRow> {
  const stored = storedRules(settings, column);
  if (stored !== null) return stored;
  const off = new Set(
    (Object.keys(HERMES_PIPELINE_ROWS) as ReadonlyArray<HermesPipelineKey>)
      .filter((key) => HERMES_PIPELINE_ROWS[key].column === column)
      .filter((key) => settings[LEGACY_FLAG[key]] !== true)
      .map((key) => `${HERMES_PIPELINE_ROWS[key].when}:${HERMES_PIPELINE_ROWS[key].then}`),
  );
  return defaultRules(column).filter((rule) => !off.has(`${rule.when}:${rule.then}`));
}

/** Turn one pipeline policy on or off by writing its row, nothing else. */
export function hermesPipelinePatch(
  settings: BoardSettings,
  key: HermesPipelineKey,
  on: boolean,
): Partial<BoardSettings> {
  const row = HERMES_PIPELINE_ROWS[key];
  const current = effectiveRules(settings, row.column);
  const without = current.filter(
    (rule) => !(rule.when === row.when && rule.then === row.then && rule.arg === row.arg),
  );
  return rulesPatch(
    settings,
    row.column,
    on ? [...without, { when: row.when, then: row.then, arg: row.arg }] : without,
  );
}

/** Keep only shaped rows; unknown verbs survive, malformed objects do not. */
export function sanitizeRules(value: unknown): Record<string, ReadonlyArray<BoardRuleRow>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, ReadonlyArray<BoardRuleRow>> = {};
  for (const [column, rows] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(rows) || column.trim().length === 0) continue;
    const rules: BoardRuleRow[] = [];
    for (const raw of rows) {
      const rule = raw as Partial<BoardRuleRow> | null;
      const when = typeof rule?.when === "string" ? rule.when.trim() : "";
      const then = typeof rule?.then === "string" ? rule.then.trim() : "";
      if (!when || !then) continue;
      rules.push({ when, then, arg: typeof rule?.arg === "string" ? rule.arg.trim() : "" });
    }
    out[column] = rules;
  }
  return out;
}
