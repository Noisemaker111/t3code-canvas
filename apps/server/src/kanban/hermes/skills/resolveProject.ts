import type { HermesRoutingSkill } from "./types.ts";

export const resolveProjectSkill: HermesRoutingSkill = {
  id: "resolve-project",
  purpose: "Select a project from evidence, or ask the user when their intent is ambiguous.",
  instructions: [
    "A pinnedProjectId is a human constraint. Otherwise use repo identity, named paths and existing evidence, then searchProjects on one meaningful path or symbol.",
    "Exactly one credible hit is the answer; never take the first or most recent project when several are plausible.",
    "Streak evidence resolves a project only when exactly one has it: two or more board signals (recent same-project cards, active same-project threads, a last successful human-routed card). It is not a last-project default, and two projects with it are still ambiguous.",
    "No hits, several plausible projects, or a failed search means the intent is missing: askUser once with the cardId, one plain question and the project slugs as options — then leave it queued until a [message] answers, and finish the plan in that tick.",
  ],
};
