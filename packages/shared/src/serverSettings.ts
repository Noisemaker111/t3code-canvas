import { ServerSettings, type ServerSettingsPatch } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { deepMerge } from "./Struct.ts";
import { fromLenientJson } from "./schemaJson.ts";
import { createModelSelection } from "./model.ts";

const ServerSettingsJson = fromLenientJson(ServerSettings);
const decodeServerSettingsJson = Schema.decodeUnknownOption(ServerSettingsJson);

export interface PersistedServerObservabilitySettings {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
}

export function normalizePersistedServerSettingString(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function extractPersistedServerObservabilitySettings(input: {
  readonly observability?: {
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
  };
}): PersistedServerObservabilitySettings {
  return {
    otlpTracesUrl: normalizePersistedServerSettingString(input.observability?.otlpTracesUrl),
    otlpMetricsUrl: normalizePersistedServerSettingString(input.observability?.otlpMetricsUrl),
  };
}

export function parsePersistedServerObservabilitySettings(
  raw: string,
): PersistedServerObservabilitySettings {
  const decoded = decodeServerSettingsJson(raw);
  if (Option.isSome(decoded)) {
    return extractPersistedServerObservabilitySettings(decoded.value);
  }
  return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
}

type ModelSelectionKey = "textGenerationModelSelection" | "defaultModelSelection";
type ModelSelectionPatch = NonNullable<ServerSettingsPatch["textGenerationModelSelection"]>;

function shouldReplaceModelSelection(patch: ModelSelectionPatch): boolean {
  return patch.instanceId !== undefined || patch.model !== undefined;
}

function mergeModelSelectionOptionsById(input: {
  current: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
  patch: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
}): Array<{ id: string; value: string | boolean }> | undefined {
  if (input.patch === undefined) {
    return input.current ? [...input.current] : undefined;
  }
  if (input.patch.length === 0) {
    return undefined;
  }

  const merged = new Map((input.current ?? []).map((selection) => [selection.id, selection.value]));
  for (const selection of input.patch) {
    merged.set(selection.id, selection.value);
  }
  return [...merged.entries()].map(([id, value]) => ({ id, value }));
}

function applyModelSelectionPatch(
  current: ServerSettings[ModelSelectionKey],
  patch: ModelSelectionPatch,
): ServerSettings[ModelSelectionKey] {
  const instanceId = patch.instanceId ?? current.instanceId;
  const model = patch.model ?? current.model;
  const options = shouldReplaceModelSelection(patch)
    ? patch.options
    : mergeModelSelectionOptionsById({ current: current.options, patch: patch.options });
  return createModelSelection(instanceId, model, options);
}

const MODEL_SELECTION_KEYS: ReadonlyArray<ModelSelectionKey> = [
  "textGenerationModelSelection",
  "defaultModelSelection",
];

/**
 * Applies a server settings patch while treating the model-selection fields as
 * replace-on-instance/model updates. This prevents stale nested options from
 * surviving a reset patch that intentionally omits options.
 */
export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const { automaticGitFetchInterval, ...patchForMerge } = patch;
  const next = deepMerge(current, patchForMerge);
  const nextWithReplacements = {
    ...next,
    ...(patch.providerInstances !== undefined
      ? { providerInstances: patch.providerInstances }
      : {}),
    ...(patch.skillCommands !== undefined ? { skillCommands: patch.skillCommands } : {}),
    ...(patch.boardSettings !== undefined ? { boardSettings: patch.boardSettings } : {}),
    ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
  };

  for (const key of MODEL_SELECTION_KEYS) {
    const selectionPatch = patch[key];
    if (!selectionPatch) continue;
    nextWithReplacements[key] = applyModelSelectionPatch(current[key], selectionPatch);
  }

  return nextWithReplacements;
}
