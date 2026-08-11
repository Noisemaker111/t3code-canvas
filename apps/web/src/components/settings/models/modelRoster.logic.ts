import { type BoardModelRosterEntry, type ProviderOptionSelection } from "@t3tools/contracts";
import { CLAIM_ANSWERED_BY, measuredClaimsIn } from "@t3tools/shared/rosterRuleClaims";

/** One sentence is the point; a paragraph is prompt bloat on every tick. */
export const ROSTER_NOTE_MAX = 240;

export function rosterKey(entry: { instanceId: string; model: string }): string {
  return `${entry.instanceId}::${entry.model}`;
}

export function isOnRoster(
  roster: ReadonlyArray<BoardModelRosterEntry>,
  candidate: { instanceId: string; model: string },
): boolean {
  const key = rosterKey(candidate);
  return roster.some((entry) => rosterKey(entry) === key);
}

/** Append an empty rule. A rule with no model yet is not representable, so callers pick first. */
export function addToRoster(
  roster: ReadonlyArray<BoardModelRosterEntry>,
  candidate: { instanceId: string; model: string },
  note = "",
): ReadonlyArray<BoardModelRosterEntry> {
  if (isOnRoster(roster, candidate)) return roster;
  return [
    ...roster,
    { instanceId: candidate.instanceId, model: candidate.model, note, options: [] },
  ];
}

export function removeRosterEntry(
  roster: ReadonlyArray<BoardModelRosterEntry>,
  index: number,
): ReadonlyArray<BoardModelRosterEntry> {
  if (index < 0 || index >= roster.length) return roster;
  return roster.filter((_entry, current) => current !== index);
}

/** Move a rule up (-1) or down (+1) the totem pole. Out-of-range moves are no-ops. */
export function moveRosterEntry(
  roster: ReadonlyArray<BoardModelRosterEntry>,
  index: number,
  delta: number,
): ReadonlyArray<BoardModelRosterEntry> {
  const target = index + delta;
  if (index < 0 || index >= roster.length || target < 0 || target >= roster.length) return roster;
  const next = [...roster];
  const [moved] = next.splice(index, 1);
  if (!moved) return roster;
  next.splice(target, 0, moved);
  return next;
}

export function setRosterNote(
  roster: ReadonlyArray<BoardModelRosterEntry>,
  index: number,
  note: string,
): ReadonlyArray<BoardModelRosterEntry> {
  if (index < 0 || index >= roster.length) return roster;
  return roster.map((entry, current) =>
    current === index ? { ...entry, note: note.slice(0, ROSTER_NOTE_MAX) } : entry,
  );
}

/**
 * Point a rule at a different model. A move onto a model another rule already
 * holds is dropped: two rules for one model are two conflicting instructions.
 */
export function setRosterModel(
  roster: ReadonlyArray<BoardModelRosterEntry>,
  index: number,
  candidate: { instanceId: string; model: string },
): ReadonlyArray<BoardModelRosterEntry> {
  if (index < 0 || index >= roster.length) return roster;
  const key = rosterKey(candidate);
  if (roster.some((entry, current) => current !== index && rosterKey(entry) === key)) return roster;
  // Options are per-model (a Codex effort id means nothing to Claude), so a
  // repoint starts from the new model's defaults instead of carrying stale ids.
  return roster.map((entry, current) =>
    current === index
      ? { ...entry, instanceId: candidate.instanceId, model: candidate.model, options: [] }
      : entry,
  );
}

/**
 * Set a seat's thinking band. `min === max` collapses to a pinned effort
 * option (today's fixed behavior); a wider band clears the fixed option and
 * leaves the level to the router.
 */
export function setRosterEffortRange(
  roster: ReadonlyArray<BoardModelRosterEntry>,
  index: number,
  range: { min: string; max: string },
): ReadonlyArray<BoardModelRosterEntry> {
  if (index < 0 || index >= roster.length) return roster;
  return roster.map((entry, current) => {
    if (current !== index) return entry;
    if (range.min === range.max) {
      const rest = entry.options.filter((existing) => existing.id !== "effort");
      const { effortRange: _dropped, ...kept } = entry;
      return { ...kept, options: [...rest, { id: "effort", value: range.min }] };
    }
    return {
      ...entry,
      options: entry.options.filter((existing) => existing.id !== "effort"),
      effortRange: range,
    };
  });
}

/** Set one provider option (reasoning effort, fast mode, …) on a rule. */
export function setRosterOption(
  roster: ReadonlyArray<BoardModelRosterEntry>,
  index: number,
  option: ProviderOptionSelection,
): ReadonlyArray<BoardModelRosterEntry> {
  if (index < 0 || index >= roster.length) return roster;
  return roster.map((entry, current) => {
    if (current !== index) return entry;
    const rest = entry.options.filter((existing) => existing.id !== option.id);
    return { ...entry, options: [...rest, option] };
  });
}

export type RosterWarning = { readonly index: number; readonly detail: string };

/** A seat with no sentence tells Hermes nothing — it is a model with no rule. */
export function rulesMissingNotes(
  roster: ReadonlyArray<BoardModelRosterEntry>,
): ReadonlyArray<RosterWarning> {
  return roster.flatMap((entry, index) =>
    entry.note.trim().length === 0
      ? [{ index, detail: `${entry.model} has no description of what it is for.` }]
      : [],
  );
}

/**
 * A rule stating something the box measures. The server strips these before
 * Hermes reads them, so this warning explains a rule that is already partly
 * inert rather than threatening to make it so.
 */
export function rulesClaimingMeasuredFacts(
  roster: ReadonlyArray<BoardModelRosterEntry>,
): ReadonlyArray<RosterWarning> {
  return roster.flatMap((entry, index) => {
    const claims = measuredClaimsIn(entry.note);
    if (claims.length === 0) return [];
    const answered = [...new Set(claims.map((claim) => CLAIM_ANSWERED_BY[claim.kind]))].join(", ");
    return [
      {
        index,
        detail: `${claims.map((claim) => `"${claim.text}"`).join(" · ")} — ${answered} measure that.`,
      },
    ];
  });
}
