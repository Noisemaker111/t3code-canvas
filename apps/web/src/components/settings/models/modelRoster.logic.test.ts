import { describe, expect, it } from "@effect/vitest";

import {
  addToRoster,
  isOnRoster,
  moveRosterEntry,
  removeRosterEntry,
  rulesMissingNotes,
  setRosterModel,
  setRosterNote,
} from "./modelRoster.logic";

const haiku = { instanceId: "claudeAgent", model: "claude-haiku-4-5" };
const opus = { instanceId: "claudeAgent", model: "claude-opus-4-5" };

describe("modelRoster.logic", () => {
  it("adds without duplicating", () => {
    const once = addToRoster([], haiku);
    expect(addToRoster(once, haiku)).toBe(once);
    expect(isOnRoster(once, haiku)).toBe(true);
    expect(isOnRoster(once, opus)).toBe(false);
  });

  it("removes a rule by position", () => {
    expect(removeRosterEntry(addToRoster([], haiku), 0)).toEqual([]);
    const roster = addToRoster([], haiku);
    expect(removeRosterEntry(roster, 3)).toBe(roster);
  });

  it("moves rules up and down, ignoring out-of-range", () => {
    const roster = addToRoster(addToRoster([], haiku), opus);
    expect(moveRosterEntry(roster, 1, -1)[0]?.model).toBe(opus.model);
    expect(moveRosterEntry(roster, 0, -1)).toBe(roster);
    expect(moveRosterEntry(roster, 1, 1)).toBe(roster);
  });

  it("edits the sentence a rule carries", () => {
    const roster = setRosterNote(addToRoster([], haiku), 0, "Quick copy and style fixes.");
    expect(roster[0]?.note).toBe("Quick copy and style fixes.");
    expect(setRosterNote(roster, 9, "x")).toBe(roster);
  });

  it("repoints a rule at another model but never onto a model already ruled", () => {
    const roster = addToRoster(addToRoster([], haiku), opus);
    expect(setRosterModel(roster, 0, opus)).toBe(roster);
    const single = addToRoster([], haiku);
    expect(setRosterModel(single, 0, opus)[0]?.model).toBe(opus.model);
  });

  it("reports rules with no sentence", () => {
    const roster = setRosterNote(addToRoster(addToRoster([], haiku), opus), 0, "Small fixes.");
    expect(rulesMissingNotes(roster).map((warning) => warning.index)).toEqual([1]);
  });
});
