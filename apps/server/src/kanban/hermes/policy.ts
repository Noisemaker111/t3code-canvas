import type { BoardSettings } from "@t3tools/contracts";
import { boardRulePolicy } from "@t3tools/shared/boardRules";

export type HermesBoardPolicy = {
  readonly autoMoveDraftsToPrompts: boolean;
  readonly structureDrafts: boolean;
  readonly autoLaunch: boolean;
  readonly stuckPrepMs: number;
};

export function hermesBoardPolicy(settings: BoardSettings): HermesBoardPolicy {
  const rules = boardRulePolicy(settings);
  return {
    autoMoveDraftsToPrompts: settings.hermesAutoMoveDraftsToPrompts,
    structureDrafts: rules.structureDrafts,
    autoLaunch: rules.launchPrompts,
    stuckPrepMs: settings.hermesStuckPrepMs,
  };
}
