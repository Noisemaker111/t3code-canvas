import type { ProviderInstanceId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  readBoardSettings,
  subscribeBoardSettings,
  updateBoardSettings,
} from "../../lib/boardSettings";
import {
  AUTO_ROUTER_DESCRIPTION,
  AUTO_ROUTER_LABEL,
  composerPresetSelection,
  readComposerModelPreset,
  type ComposerModelPreset,
} from "../../lib/composerModelPreset";
import type { ModelEsque } from "../chat/providerIconUtils";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { useProviderInstancePicker } from "../settings/InstanceModelSelect";

/** Board-settings-backed composer preset, live across tabs and both composers. */
export function useComposerModelPreset() {
  const [preset, setPreset] = useState<ComposerModelPreset | null>(() =>
    readComposerModelPreset(readBoardSettings()),
  );

  useEffect(
    () => subscribeBoardSettings((settings) => setPreset(readComposerModelPreset(settings))),
    [],
  );

  const setStoredPreset = useCallback((next: ComposerModelPreset | null) => {
    updateBoardSettings({
      composerInstanceId: next?.instanceId ?? null,
      composerModel: next?.model ?? null,
    });
    setPreset(next);
  }, []);

  return { preset, selection: composerPresetSelection(preset), setPreset: setStoredPreset };
}

/**
 * The thread model picker, in board contexts: same component, plus an
 * "Auto Router" row that hands the choice back to the board.
 */
export function BoardModelPicker({
  preset,
  onChange,
  disabled,
  triggerClassName,
  compact,
}: {
  preset: ComposerModelPreset | null;
  onChange: (next: ComposerModelPreset | null) => void;
  disabled?: boolean;
  triggerClassName?: string;
  compact?: boolean;
}) {
  const picker = useProviderInstancePicker();

  const modelOptionsByInstance = useMemo<
    ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>
  >(() => {
    const out = new Map<ProviderInstanceId, ReadonlyArray<ModelEsque>>();
    for (const entry of picker.instances) {
      out.set(entry.instanceId, picker.modelOptionsFor(entry));
    }
    return out;
  }, [picker]);

  const getModelDisabledReason = useCallback(
    (instanceId: ProviderInstanceId) => {
      const entry = picker.findInstance(instanceId);
      if (!entry) return null;
      const { selectable, suffix } = picker.instanceLabel(entry);
      return selectable ? null : suffix.replace(/^\s*[—-]\s*/u, "").trim() || "Unavailable";
    },
    [picker],
  );

  const activeInstanceId = (preset?.instanceId ??
    picker.instances[0]?.instanceId ??
    "") as ProviderInstanceId;

  return (
    <ProviderModelPicker
      activeInstanceId={activeInstanceId}
      model={preset?.model ?? ""}
      lockedProvider={null}
      instanceEntries={picker.instances}
      modelOptionsByInstance={modelOptionsByInstance}
      triggerVariant="outline"
      {...(triggerClassName ? { triggerClassName } : {})}
      {...(compact === undefined ? {} : { compact })}
      {...(disabled === undefined ? {} : { disabled })}
      getModelDisabledReason={getModelDisabledReason}
      autoOption={{
        label: AUTO_ROUTER_LABEL,
        description: AUTO_ROUTER_DESCRIPTION,
        selected: preset === null,
        onSelect: () => onChange(null),
      }}
      onInstanceModelChange={(instanceId, model) => onChange({ instanceId, model })}
    />
  );
}
