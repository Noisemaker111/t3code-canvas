export type HermesRoutingSkillId =
  | "understand-task"
  | "resolve-project"
  | "select-execution"
  | "place-work";

export type HermesRoutingSkill = {
  readonly id: HermesRoutingSkillId;
  readonly purpose: string;
  readonly instructions: ReadonlyArray<string>;
};
