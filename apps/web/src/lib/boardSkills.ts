/**
 * Board skill pipeline: each skill is an LLM transform (Hermes model when set),
 * not a string append. Skills run top → bottom in the given order.
 *
 * These are optional prompt transforms. Project/model/effort/placement routing
 * belongs exclusively to Hermes's server-side semantic routing skills.
 */
import type { PromptAssistModelSelection } from "@t3tools/contracts";
import { stripKanbanProjectModelHeaders } from "@t3tools/shared/kanbanPromptFormat";

import {
  buildSkillLlmMessage,
  CORE_BOARD_SKILL_IDS,
  isCoreBoardSkillId,
  mergeCoreBoardSkillIds,
} from "../components/settings/skillCommands/skillCommandsPage.logic";
import type { PromptAssistError } from "../state/promptAssist";

export type BoardSkill = {
  readonly id: string;
  readonly prompt: string;
};

export type SkillAssistFn = (
  operation: "skill",
  text: string,
  options?: { modelSelection?: PromptAssistModelSelection },
) => Promise<{ text: string } | PromptAssistError>;

/**
 * Resolve the Hermes skill list: core pipeline first, then optional always-on
 * skills that still have prompts in Global Skills.
 */
export function resolveBoardSkillPipeline(input: {
  alwaysOnSkillIds: ReadonlyArray<string>;
  skillCommands: Record<string, { prompt: string } | undefined>;
}): BoardSkill[] {
  const ids = mergeCoreBoardSkillIds(input.alwaysOnSkillIds);
  const skills: BoardSkill[] = [];
  for (const id of ids) {
    const prompt = input.skillCommands[id]?.prompt?.trim();
    if (!prompt) continue;
    skills.push({ id, prompt });
  }
  return skills;
}

export type SkillPipelineStep = {
  readonly skillId: string;
  readonly input: string;
  readonly output: string;
};

/**
 * Run skills in order. Each skill is plain instructions + current card text
 * sent to the model as operation `skill`. Output becomes next input.
 */
export async function runSkillPipeline(input: {
  source: string;
  skills: ReadonlyArray<BoardSkill>;
  assist: SkillAssistFn;
  modelSelection?: PromptAssistModelSelection;
}): Promise<{ text: string; applied: number; steps: ReadonlyArray<SkillPipelineStep> }> {
  let text = input.source.trim();
  if (text.length === 0) {
    throw new Error("Write something before running skills.");
  }
  let applied = 0;
  const steps: SkillPipelineStep[] = [];
  const opts = input.modelSelection ? { modelSelection: input.modelSelection } : undefined;

  for (const skill of input.skills) {
    const skillPrompt = skill.prompt.trim();
    if (skillPrompt.length === 0) continue;
    const stepInput = text;
    const message = buildSkillLlmMessage(skillPrompt, text);
    const result = await input.assist("skill", message, opts);
    if ("message" in result) {
      throw new Error(`Skill /${skill.id}: ${result.message}`);
    }
    const next = stripKanbanProjectModelHeaders(result.text);
    if (next.length === 0) {
      throw new Error(`Skill /${skill.id} returned empty output.`);
    }
    steps.push({ skillId: skill.id, input: stepInput, output: next });
    text = next;
    applied += 1;
  }

  return { text: stripKanbanProjectModelHeaders(text), applied, steps };
}

export { CORE_BOARD_SKILL_IDS, isCoreBoardSkillId, mergeCoreBoardSkillIds };
