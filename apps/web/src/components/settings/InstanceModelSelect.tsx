import { useAtomValue } from "@effect/atom-react";
import type { ProviderInstanceId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useUsageSnapshot } from "../../hooks/useUsageSnapshot";
import { providerUsageUnusableReason } from "../../lib/providerUsage";
import { getAppModelOptionsForInstance, type AppModelOption } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { primaryServerProvidersAtom } from "../../state/server";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SearchableModelSelect } from "./SearchableModelSelect";

export interface InstancePickerLabel {
  readonly selectable: boolean;
  readonly suffix: string;
}

export function instancePickerLabel(
  entry: ProviderInstanceEntry,
  usageReason: string | null,
): InstancePickerLabel {
  if (!entry.enabled) {
    return { selectable: false, suffix: " (off)" };
  }
  if (usageReason) {
    return { selectable: false, suffix: ` — ${usageReason}` };
  }
  if (!entry.installed) {
    return { selectable: false, suffix: " — not installed" };
  }
  if (!entry.isAvailable || entry.status === "error") {
    const detail = entry.snapshot.message?.trim();
    return {
      selectable: false,
      suffix: detail ? ` — ${detail}` : " — unavailable",
    };
  }
  if (entry.status !== "ready" && entry.status !== "warning") {
    return { selectable: false, suffix: " — not ready" };
  }
  // warning (e.g. Grok auth unverified) remains selectable when enabled+installed
  if (!isProviderInstancePickerReady(entry) && entry.status !== "warning") {
    return { selectable: false, suffix: " — not ready" };
  }
  return { selectable: true, suffix: "" };
}

export interface ProviderInstancePicker {
  readonly instances: ReadonlyArray<ProviderInstanceEntry>;
  readonly instanceLabel: (entry: ProviderInstanceEntry) => InstancePickerLabel;
  readonly isInstanceSelectable: (entry: ProviderInstanceEntry) => boolean;
  readonly findInstance: (
    instanceId: string | null | undefined,
  ) => ProviderInstanceEntry | undefined;
  readonly modelOptionsFor: (
    entry: ProviderInstanceEntry | undefined,
  ) => ReadonlyArray<AppModelOption>;
}

/**
 * Shared source of truth for "which instance + model can the user pick".
 * Board settings (Hermes) and the board card editor all read
 * this so a model hidden or reordered in Settings → Models behaves the same
 * everywhere.
 */
export function useProviderInstancePicker(): ProviderInstancePicker {
  const unified = usePrimarySettings();
  const providerStatuses = useAtomValue(primaryServerProvidersAtom);
  const usageSnapshot = useUsageSnapshot();

  const instances = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providerStatuses), unified),
      ),
    [providerStatuses, unified],
  );

  const instanceLabel = useCallback(
    (entry: ProviderInstanceEntry) =>
      instancePickerLabel(entry, providerUsageUnusableReason(usageSnapshot.data, entry.instanceId)),
    [usageSnapshot.data],
  );

  const isInstanceSelectable = useCallback(
    (entry: ProviderInstanceEntry) => instanceLabel(entry).selectable,
    [instanceLabel],
  );

  const findInstance = useCallback(
    (instanceId: string | null | undefined) =>
      instanceId ? instances.find((entry) => entry.instanceId === instanceId) : undefined,
    [instances],
  );

  const modelOptionsFor = useCallback(
    (entry: ProviderInstanceEntry | undefined) =>
      entry ? getAppModelOptionsForInstance(unified, entry) : [],
    [unified],
  );

  return useMemo(
    () => ({ instances, instanceLabel, isInstanceSelectable, findInstance, modelOptionsFor }),
    [findInstance, instanceLabel, instances, isInstanceSelectable, modelOptionsFor],
  );
}

/** Instance dropdown + searchable model list, stacked. */
export function InstanceModelSelect(props: {
  readonly picker: ProviderInstancePicker;
  readonly instanceId: ProviderInstanceId | string | null;
  readonly model: string;
  readonly modelOptions: ReadonlyArray<AppModelOption>;
  readonly onInstanceChange: (instanceId: string) => void;
  readonly onModelChange: (slug: string) => void;
  readonly disabled?: boolean;
  readonly instancePlaceholder?: string;
  readonly modelPlaceholder?: string;
}) {
  const { instances, instanceLabel, isInstanceSelectable } = props.picker;
  // Base UI renders the raw option value in the trigger unless given children,
  // which surfaced instance ids like `claudeAgent` instead of "Claude".
  const selectedEntry = instances.find((entry) => entry.instanceId === props.instanceId);
  return (
    <>
      <Select
        value={props.instanceId ?? ""}
        disabled={props.disabled}
        onValueChange={(value) => {
          if (value == null || value === "") return;
          const entry = instances.find((item) => item.instanceId === value);
          if (entry && !isInstanceSelectable(entry)) return;
          props.onInstanceChange(value);
        }}
      >
        <SelectTrigger size="sm" className="w-full min-w-[12rem]">
          <SelectValue placeholder={props.instancePlaceholder ?? "Instance"}>
            {selectedEntry?.displayName}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {instances.map((entry) => {
            const { selectable, suffix } = instanceLabel(entry);
            return (
              <SelectItem key={entry.instanceId} value={entry.instanceId} disabled={!selectable}>
                {entry.displayName}
                {suffix}
              </SelectItem>
            );
          })}
        </SelectPopup>
      </Select>
      <SearchableModelSelect
        options={props.modelOptions}
        value={props.model}
        disabled={props.disabled ?? false}
        placeholder={props.modelPlaceholder ?? "Model"}
        onChange={props.onModelChange}
      />
    </>
  );
}
