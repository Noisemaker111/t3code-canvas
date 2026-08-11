import type { HermesRoutingSkill } from "./types.ts";

export const understandTaskSkill: HermesRoutingSkill = {
  id: "understand-task",
  purpose: "Interpret the complete request without keyword or length classification.",
  instructions: [
    "Read the whole prompt: risk, ambiguity, repository work, verification, consequences of failure.",
    "Split only independent deliverables; criteria and steps for one outcome stay one task.",
    "Return an expectedWork shape for every task; never emit small/medium/large.",
  ],
};
