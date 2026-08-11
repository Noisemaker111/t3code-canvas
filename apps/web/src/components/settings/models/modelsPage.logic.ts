import * as Arr from "effect/Array";
import * as Equal from "effect/Equal";
import * as Result from "effect/Result";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { buildProviderInstanceUpdatePatch } from "../SettingsPanels.logic";
import { DRIVER_OPTIONS } from "../providerDriverMeta";

/**
 * Read a string[] at `key` from the opaque config blob, filtering out
 * non-string entries. Used for `customModels`, which is always typed as
 * `string[]` by the concrete driver schemas but arrives here as
 * `Schema.Unknown`.
 */
export function readConfigStringArray(config: unknown, key: string): ReadonlyArray<string> {
  if (config === null || typeof config !== "object") return [];
  const value = (config as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Set `key` to an arbitrary value on the opaque config blob. Unlike
 * provider settings field updates, does not drop empty-looking values — the
 * caller is responsible for deciding whether an empty array / empty
 * object should be stored explicitly (e.g. `customModels: []` is a
 * meaningful "user cleared their custom list" state distinct from
 * "driver default").
 */
export function nextConfigBlobWithValue(
  config: unknown,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    config !== null && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};
  base[key] = value;
  return base;
}

export function deriveProviderModelsForDisplay(input: {
  readonly liveModels: ReadonlyArray<ServerProviderModel> | undefined;
  readonly customModels: ReadonlyArray<string>;
}): ReadonlyArray<ServerProviderModel> {
  const liveCustomModelsBySlug = new Map(
    Arr.filterMap(input.liveModels ?? [], (model) =>
      model.isCustom ? Result.succeed([model.slug, model] as const) : Result.failVoid,
    ),
  );
  const serverModels = input.liveModels?.filter((model) => !model.isCustom) ?? [];
  const customModels = input.customModels.map(
    (slug) =>
      liveCustomModelsBySlug.get(slug) ?? {
        slug,
        name: slug,
        isCustom: true,
        capabilities: null,
      },
  );
  return [...serverModels, ...customModels];
}

/** Placeholder text for the "add a custom model" input, keyed by driver kind. */
export const CUSTOM_MODEL_PLACEHOLDER_BY_KIND: Partial<Record<ProviderDriverKind, string>> = {
  [ProviderDriverKind.make("codex")]: "gpt-6.7-codex-ultra-preview",
  [ProviderDriverKind.make("claudeAgent")]: "claude-sonnet-5",
  [ProviderDriverKind.make("cursor")]: "claude-sonnet-4-6",
  [ProviderDriverKind.make("opencode")]: "openai/gpt-5",
};

/** Capability badge labels shown in a model row's info tooltip. */
export function getModelCapabilityLabels(model: ServerProviderModel): string[] {
  const labels: string[] = [];
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  if (descriptors.some((descriptor) => descriptor.id === "fastMode")) {
    labels.push("Fast mode");
  }
  if (descriptors.some((descriptor) => descriptor.id === "thinking")) {
    labels.push("Thinking");
  }
  if (
    descriptors.some(
      (descriptor) =>
        descriptor.type === "select" &&
        (descriptor.id === "reasoningEffort" ||
          descriptor.id === "effort" ||
          descriptor.id === "reasoning" ||
          descriptor.id === "variant"),
    )
  ) {
    labels.push("Reasoning");
  }
  return labels;
}

export function withoutProviderInstanceKey<V>(
  record: Readonly<Record<ProviderInstanceId, V>> | undefined,
  key: ProviderInstanceId,
): Record<ProviderInstanceId, V> {
  const next = { ...record } as Record<ProviderInstanceId, V>;
  delete next[key];
  return next;
}

export function withoutProviderInstanceFavorites(
  favorites: ReadonlyArray<{ readonly provider: ProviderInstanceId; readonly model: string }>,
  instanceId: ProviderInstanceId,
) {
  return favorites.filter((favorite) => favorite.provider !== instanceId);
}

export function buildProviderModelPreferencesPatch(
  settings: Pick<UnifiedSettings, "providerModelPreferences">,
  instanceId: ProviderInstanceId,
  next: {
    readonly hiddenModels: ReadonlyArray<string>;
    readonly modelOrder: ReadonlyArray<string>;
  },
): Partial<UnifiedSettings> {
  const hiddenModels = [...new Set(next.hiddenModels.filter((slug) => slug.trim().length > 0))];
  const modelOrder = [...new Set(next.modelOrder.filter((slug) => slug.trim().length > 0))];
  const rest = withoutProviderInstanceKey(settings.providerModelPreferences, instanceId);
  return {
    providerModelPreferences:
      hiddenModels.length === 0 && modelOrder.length === 0
        ? rest
        : {
            ...rest,
            [instanceId]: { hiddenModels, modelOrder },
          },
  };
}

export function buildProviderFavoriteModelsPatch(
  settings: Pick<UnifiedSettings, "favorites">,
  instanceId: ProviderInstanceId,
  nextFavoriteModels: ReadonlyArray<string>,
): Partial<UnifiedSettings> {
  const favoriteModels = [
    ...new Set(
      Arr.filterMap(nextFavoriteModels, (slug) => {
        const trimmedSlug = slug.trim();
        return trimmedSlug.length > 0 ? Result.succeed(trimmedSlug) : Result.failVoid;
      }),
    ),
  ];
  return {
    favorites: [
      ...withoutProviderInstanceFavorites(settings.favorites ?? [], instanceId),
      ...favoriteModels.map((model) => ({ provider: instanceId, model })),
    ],
  };
}

export interface InstanceRow {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
  readonly isDirty?: boolean;
}

/**
 * Write a row's custom-model slug list back into its config blob and
 * produce the corresponding `providerInstances`/legacy-provider patch via
 * `buildProviderInstanceUpdatePatch`. Used for both adding and removing a
 * custom model slug — the caller always passes the full next array.
 */
export function buildCustomModelsPatch(
  settings: Pick<ServerSettings, "providers" | "providerInstances">,
  row: InstanceRow,
  nextCustomModels: ReadonlyArray<string>,
): Partial<UnifiedSettings> {
  const nextConfig = nextConfigBlobWithValue(row.instance.config, "customModels", [
    ...nextCustomModels,
  ]);
  const { config: _omit, ...rest } = row.instance;
  const nextInstance = { ...rest, config: nextConfig } as ProviderInstanceConfig;
  return buildProviderInstanceUpdatePatch({
    settings,
    instanceId: row.instanceId,
    instance: nextInstance,
    driver: row.driver,
    isDefault: row.isDefault,
  });
}

export const PROVIDER_SETTINGS = DRIVER_OPTIONS.map((definition) => ({
  provider: definition.value,
}));

/** Cursor is only shown once an instance has actually been probed for it. */
export function getVisibleProviderSettings(
  serverProviders: ReadonlyArray<ServerProvider>,
): ReadonlyArray<{ readonly provider: ProviderDriverKind }> {
  return PROVIDER_SETTINGS.filter(
    (providerSettings) =>
      providerSettings.provider !== "cursor" ||
      serverProviders.some(
        (provider) =>
          provider.instanceId === defaultInstanceIdForDriver(ProviderDriverKind.make("cursor")),
      ),
  );
}

/**
 * One row per configured provider instance: the built-in default slot for
 * every visible driver (promoted from the legacy `settings.providers[kind]`
 * bucket when no explicit `providerInstances[id]` entry exists yet), plus
 * every custom instance, plus any instance whose driver isn't in the
 * visible set (e.g. a fork driver) so it still round-trips.
 */
export function buildProviderInstanceRows(
  settings: Pick<ServerSettings, "providers" | "providerInstances">,
  visibleProviderSettings: ReadonlyArray<{ readonly provider: ProviderDriverKind }>,
): InstanceRow[] {
  const instancesByDriver = new Map<
    ProviderDriverKind,
    Array<[ProviderInstanceId, ProviderInstanceConfig]>
  >();
  for (const [rawId, instance] of Object.entries(settings.providerInstances ?? {})) {
    const driver = instance.driver;
    const list = instancesByDriver.get(driver) ?? [];
    list.push([rawId as ProviderInstanceId, instance]);
    instancesByDriver.set(driver, list);
  }

  const defaultSlotIdsBySource = new Set<string>(
    visibleProviderSettings.map((providerSettings) =>
      String(defaultInstanceIdForDriver(providerSettings.provider)),
    ),
  );

  const rows: InstanceRow[] = [];
  const visibleDriverKinds = new Set<ProviderDriverKind>(
    visibleProviderSettings.map((providerSettings) => providerSettings.provider),
  );

  for (const providerSettings of visibleProviderSettings) {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
    const legacyProviders = settings.providers as Record<string, LegacyProviderSettings>;
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings
    >;
    const driver = providerSettings.provider;
    const defaultInstanceId = defaultInstanceIdForDriver(driver);
    const explicitInstance = settings.providerInstances?.[defaultInstanceId];
    const legacyConfig = legacyProviders[providerSettings.provider]!;
    const defaultLegacyConfig = defaultLegacyProviders[providerSettings.provider]!;
    const effectiveInstance: ProviderInstanceConfig =
      explicitInstance ??
      ({
        driver,
        enabled: legacyConfig.enabled,
        config: legacyConfig,
      } satisfies ProviderInstanceConfig);
    const isDirty =
      explicitInstance !== undefined || !Equal.equals(legacyConfig, defaultLegacyConfig);
    rows.push({
      instanceId: defaultInstanceId,
      instance: effectiveInstance,
      driver,
      isDefault: true,
      isDirty,
    });
    for (const [id, instance] of instancesByDriver.get(providerSettings.provider) ?? []) {
      if (id === defaultInstanceId) continue;
      rows.push({ instanceId: id, instance, driver: instance.driver, isDefault: false });
    }
  }
  for (const [driver, list] of instancesByDriver) {
    if (visibleDriverKinds.has(driver)) continue;
    for (const [id, instance] of list) {
      rows.push({
        instanceId: id,
        instance,
        driver: instance.driver,
        isDefault: defaultSlotIdsBySource.has(String(id)),
      });
    }
  }
  return rows;
}

/** Case-insensitive substring match against a model's slug or display name. */
export function modelMatchesSearchQuery(model: ServerProviderModel, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return (
    model.slug.toLowerCase().includes(normalized) || model.name.toLowerCase().includes(normalized)
  );
}
