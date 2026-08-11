import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ModelCapabilities,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
  type ModelSelection,
} from "@t3tools/contracts";
import {
  createModelCapabilities,
  normalizeCustomModelSlug,
  normalizeModelSlug,
} from "@t3tools/shared/model";

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");

/**
 * Keep a stale Claude default from launching an unauthenticated turn. When
 * Codex is ready, use its cheap board-approved model; otherwise retain the
 * selection so the caller can show one login error instead of retrying.
 */
export function guardDefaultModelSelection(
  selection: ModelSelection | null | undefined,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  if (!selection) return null;
  const selected = providers.find((provider) => provider.instanceId === selection.instanceId);
  if (
    selected?.driver !== ProviderDriverKind.make("claudeAgent") ||
    selected.auth.status !== "unauthenticated"
  ) {
    return selection;
  }
  const codex = providers.find(
    (provider) =>
      provider.instanceId === defaultInstanceIdForDriver(DEFAULT_DRIVER_KIND) &&
      provider.driver === DEFAULT_DRIVER_KIND,
  );
  if (
    codex?.enabled &&
    codex.installed &&
    codex.status === "ready" &&
    codex.auth.status !== "unauthenticated" &&
    codex.models.some((model) => model.slug === DEFAULT_GIT_TEXT_GENERATION_MODEL)
  ) {
    return {
      instanceId: codex.instanceId,
      model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
    };
  }
  return selection;
}

export function formatProviderDriverKindLabel(provider: ProviderDriverKind): string {
  return provider
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function getProviderModels(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): ReadonlyArray<ServerProviderModel> {
  return getProviderSnapshot(providers, provider)?.models ?? [];
}

export function getProviderSnapshot(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): ServerProvider | undefined {
  const defaultInstanceId = defaultInstanceIdForDriver(provider);
  return providers.find((candidate) => candidate.instanceId === defaultInstanceId);
}

export function getProviderDisplayName(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): string {
  const snapshot = getProviderSnapshot(providers, provider);
  return snapshot?.displayName?.trim() || formatProviderDriverKindLabel(provider);
}

export function getProviderInteractionModeToggle(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): boolean {
  return getProviderSnapshot(providers, provider)?.showInteractionModeToggle ?? true;
}

export function isProviderEnabled(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): boolean {
  if (providers.length === 0) {
    return true;
  }
  return getProviderSnapshot(providers, provider)?.enabled ?? false;
}

// Resolve an instance selection to the correlated live driver. If the
// instance is absent, fall back to a live enabled provider instead of
// inferring a driver from the missing instance id.
export function resolveSelectableProvider(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind | ProviderInstanceId | null | undefined,
): ProviderDriverKind {
  const requestedEntry = providers.find((candidate) => candidate.instanceId === provider);
  if (requestedEntry?.enabled) {
    return requestedEntry.driver;
  }
  return providers.find((candidate) => candidate.enabled)?.driver ?? DEFAULT_DRIVER_KIND;
}

export function getProviderModelCapabilities(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  provider: ProviderDriverKind,
): ModelCapabilities {
  const exactSlug = normalizeCustomModelSlug(model);
  const exactMatch = models.find((candidate) => candidate.slug === exactSlug);
  if (exactMatch) {
    return exactMatch.capabilities;
  }
  const slug = normalizeModelSlug(model, provider);
  return models.find((candidate) => candidate.slug === slug)?.capabilities ?? EMPTY_CAPABILITIES;
}

export function getDefaultServerModel(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): string {
  const models = getProviderModels(providers, provider);
  return (
    models.find((model) => !model.isCustom)?.slug ??
    models[0]?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[provider] ??
    DEFAULT_MODEL
  );
}
