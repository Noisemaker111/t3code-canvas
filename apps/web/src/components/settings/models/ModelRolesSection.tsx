"use client";

import { useAtomValue } from "@effect/atom-react";
import { ProviderInstanceId, type ProviderDriverKind } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import * as Equal from "effect/Equal";
import { useCallback, useMemo } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../../hooks/useSettings";

import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../../providerInstances";
import { primaryServerProvidersAtom } from "../../../state/server";
import { ProviderModelPicker } from "../../chat/ProviderModelPicker";
import { TraitsPicker } from "../../chat/TraitsPicker";

import { useProviderInstancePicker } from "../InstanceModelSelect";
import { SettingResetButton, SettingsRow, SettingsSection } from "../settingsLayout";

/**
 * Every global "which model runs X" choice, in one section.
 *
 * Before this, the four roles were spread across three settings pages with two
 * different pickers; Board wrote localStorage-backed board settings while the
 * other two wrote `settings.json`. The storage split is unchanged — only the
 * UI is unified, so all four use the same picker the composer uses.
 */
export function ModelRolesSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const picker = useProviderInstancePicker();

  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
      ),
    [serverProviders, settings],
  );

  // Show what is *saved*, not what would run right now. Resolving through
  // `resolveAppModelSelectionState` falls back whenever the instance is not
  // currently available — which every instance is for the first seconds after
  // a reload — so these rows rendered a fallback over the user's choice, and
  // the next edit persisted the fallback.
  const defaultSelection =
    settings.defaultModelSelection ??
    resolveAppModelSelectionState(
      settings,
      serverProviders,
      DEFAULT_UNIFIED_SETTINGS.defaultModelSelection,
    );
  const textGenSelection =
    settings.textGenerationModelSelection ??
    resolveAppModelSelectionState(settings, serverProviders);
  const textGenEntry = instanceEntries.find(
    (entry) => entry.instanceId === textGenSelection.instanceId,
  );

  const optionsByInstance = getCustomModelOptionsByInstance(settings, serverProviders);

  // Instances the picker refuses (off, not installed, usage exhausted) stay
  // visible but unselectable, with the same reason string Board used to show.
  const getModelDisabledReason = useCallback(
    (instanceId: ProviderInstanceId) => {
      const entry = picker.findInstance(instanceId);
      if (!entry) return null;
      const { selectable, suffix } = picker.instanceLabel(entry);
      return selectable ? null : suffix.replace(/^\s*[—-]\s*/, "").trim() || "Unavailable";
    },
    [picker],
  );

  const isDefaultDirty = !Equal.equals(
    settings.defaultModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.defaultModelSelection ?? null,
  );
  const isTextGenDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );

  const pickerProps = {
    lockedProvider: null,
    instanceEntries,
    modelOptionsByInstance: optionsByInstance,
    triggerVariant: "outline" as const,
    triggerClassName: "min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground",
    getModelDisabledReason,
  };

  return (
    <SettingsSection title="Model roles">
      <SettingsRow
        title="Routing fallback"
        description="Last-resort model when nothing else decides: board launches go Auto Router first, projects and threads can pick their own. This seat only runs when all of those are silent."
        resetAction={
          isDefaultDirty ? (
            <SettingResetButton
              label="default model"
              onClick={() =>
                updateSettings({
                  defaultModelSelection: DEFAULT_UNIFIED_SETTINGS.defaultModelSelection,
                })
              }
            />
          ) : null
        }
        control={
          <ProviderModelPicker
            {...pickerProps}
            activeInstanceId={defaultSelection.instanceId}
            model={defaultSelection.model}
            onInstanceModelChange={(instanceId, model) => {
              // Persist the pick verbatim. Re-resolving it here silently saved
              // a different model whenever the chosen instance was momentarily
              // unavailable (provider probe / usage snapshot still pending).
              updateSettings({ defaultModelSelection: createModelSelection(instanceId, model) });
            }}
          />
        }
      />

      <SettingsRow
        title="Utility text (Git, titles, planning)"
        description="Commit messages, PR titles, branch names, thread titles, and board-control planning — plus the launch fallback when routing has nothing better."
        resetAction={
          isTextGenDirty ? (
            <SettingResetButton
              label="text generation model"
              onClick={() =>
                updateSettings({
                  textGenerationModelSelection:
                    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                })
              }
            />
          ) : null
        }
        control={
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <ProviderModelPicker
              {...pickerProps}
              activeInstanceId={textGenSelection.instanceId}
              model={textGenSelection.model}
              onInstanceModelChange={(instanceId, model) => {
                updateSettings({
                  textGenerationModelSelection: createModelSelection(instanceId, model),
                });
              }}
            />
            <TraitsPicker
              provider={(textGenEntry?.driverKind ?? "codex") as ProviderDriverKind}
              models={textGenEntry?.models ?? []}
              model={textGenSelection.model}
              prompt=""
              onPromptChange={() => {}}
              modelOptions={textGenSelection.options}
              allowPromptInjectedEffort={false}
              triggerVariant="outline"
              triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
              onModelOptionsChange={(nextOptions) => {
                updateSettings({
                  textGenerationModelSelection: createModelSelection(
                    textGenSelection.instanceId,
                    textGenSelection.model,
                    nextOptions,
                  ),
                });
              }}
            />
          </div>
        }
      />
    </SettingsSection>
  );
}
