import { placeWorkSkill } from "./placeWork.ts";
import { resolveProjectSkill } from "./resolveProject.ts";
import { selectExecutionSkill } from "./selectExecution.ts";
import type { HermesRoutingSkill, HermesRoutingSkillId } from "./types.ts";
import { understandTaskSkill } from "./understandTask.ts";

const ROUTING_SKILLS: ReadonlyMap<HermesRoutingSkillId, HermesRoutingSkill> = new Map(
  [understandTaskSkill, resolveProjectSkill, selectExecutionSkill, placeWorkSkill].map((skill) => [
    skill.id,
    skill,
  ]),
);

export const DEFAULT_ROUTING_SKILL_IDS: ReadonlyArray<HermesRoutingSkillId> = [
  "understand-task",
  "resolve-project",
  "select-execution",
  "place-work",
];

export function loadHermesRoutingSkills(
  ids: ReadonlyArray<string> = DEFAULT_ROUTING_SKILL_IDS,
): ReadonlyArray<HermesRoutingSkill> {
  return ids
    .map((id) => ROUTING_SKILLS.get(id as HermesRoutingSkillId))
    .filter((skill): skill is HermesRoutingSkill => skill !== undefined);
}

export function formatHermesRoutingSkills(ids?: ReadonlyArray<string>): string {
  return loadHermesRoutingSkills(ids)
    .map((skill) =>
      [
        `### ${skill.id}`,
        skill.purpose,
        ...skill.instructions.map((instruction) => `- ${instruction}`),
      ].join("\n"),
    )
    .join("\n\n");
}
