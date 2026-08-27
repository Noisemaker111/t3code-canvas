export interface BoardInstanceCandidate {
  readonly instanceId: string;
  readonly enabled: boolean;
  readonly selectable: boolean;
}

/**
 * Pick the provider instance the board's Hermes skill runs use.
 *
 * Settings → Board and the board composer both resolve through this, so the
 * instance/model rendered in settings is the one the composer actually sends
 * with. They used to fall back differently (settings to the first *selectable*
 * instance, the composer to the first *enabled* one), which showed Claude in
 * settings while the composer ran an uninstalled Codex.
 */
export function resolveBoardInstanceId(
  candidates: ReadonlyArray<BoardInstanceCandidate>,
  preferred: ReadonlyArray<string | null | undefined>,
): string | null {
  for (const instanceId of preferred) {
    if (!instanceId) continue;
    if (candidates.some((entry) => entry.instanceId === instanceId && entry.selectable)) {
      return instanceId;
    }
  }
  return (
    candidates.find((entry) => entry.selectable)?.instanceId ??
    candidates.find((entry) => entry.enabled)?.instanceId ??
    candidates[0]?.instanceId ??
    null
  );
}

/** Keep a configured model only while the resolved instance still offers it. */
export function resolveBoardModel(
  configured: string | null | undefined,
  optionSlugs: ReadonlyArray<string>,
): string | null {
  if (configured && optionSlugs.includes(configured)) return configured;
  return optionSlugs[0] ?? configured ?? null;
}

/**
 * Instance a settings **role picker** should display.
 *
 * The runtime resolvers above intentionally skip an instance that is not
 * selectable right now, so the board never launches on an uninstalled CLI.
 * A settings row must not do that: providers and the usage snapshot are both
 * empty for the first seconds after a reload, so every instance is briefly
 * unselectable and the row would render the fallback instead of the saved
 * role. Rendering the fallback is not cosmetic — the next edit to any role
 * writes the whole row back, so the saved choice is destroyed by a refresh.
 */
export function resolveRoleInstanceId(
  candidates: ReadonlyArray<BoardInstanceCandidate>,
  configured: string | null | undefined,
  fallbackPreferred: ReadonlyArray<string | null | undefined> = [],
): string | null {
  if (configured) return configured;
  return resolveBoardInstanceId(candidates, fallbackPreferred);
}

/**
 * Model a settings **role picker** should display. Same reasoning as
 * `resolveRoleInstanceId`: an option list that has not loaded yet is not
 * evidence that the saved model is gone.
 */
export function resolveRoleModel(
  configured: string | null | undefined,
  optionSlugs: ReadonlyArray<string>,
): string | null {
  if (configured) return configured;
  return optionSlugs[0] ?? null;
}
