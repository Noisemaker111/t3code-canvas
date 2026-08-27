/**
 * Composer model preset — the harness + model new cards are captured with.
 * Null means Auto Router: the model-router skill and launch routing decide.
 */
import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";

import type { BoardSettings } from "./boardSettings";

export type ComposerModelPreset = {
  readonly instanceId: string;
  readonly model: string;
};

export const AUTO_ROUTER_LABEL = "Auto Router";
export const AUTO_ROUTER_DESCRIPTION = "The board picks a model per task size and cost.";

export function readComposerModelPreset(
  settings: Pick<BoardSettings, "composerInstanceId" | "composerModel">,
): ComposerModelPreset | null {
  const instanceId = settings.composerInstanceId?.trim() ?? "";
  const model = settings.composerModel?.trim() ?? "";
  if (instanceId.length === 0 || model.length === 0) return null;
  return { instanceId, model };
}

export function composerPresetSelection(preset: ComposerModelPreset | null): ModelSelection | null {
  if (!preset) return null;
  return { instanceId: ProviderInstanceId.make(preset.instanceId), model: preset.model };
}
