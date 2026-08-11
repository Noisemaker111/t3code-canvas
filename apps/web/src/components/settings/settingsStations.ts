/**
 * The one map from a settings address to a settings section.
 *
 * The canvas settings panel ({@link ../canvas/panels/SettingsPanel}) is the
 * only settings surface, and it has six sections. `/settings/*` survives purely
 * as an address space for old deep links, and the pre-merge section ids
 * (`skills`, `vps`, `diagnostics`, …) survive as aliases, so a bookmark or a
 * `?station=settings:<id>` from any age still lands on the section that now
 * owns that setting.
 */

export type SettingsSectionPath =
  | "/settings/general"
  | "/settings/keybindings"
  | "/settings/providers"
  | "/settings/models"
  | "/settings/skill-commands"
  | "/settings/board"
  | "/settings/hermes"
  | "/settings/friction"
  | "/settings/source-control"
  | "/settings/vps"
  | "/settings/connections"
  | "/settings/updates"
  | "/settings/maintenance"
  | "/settings/archived"
  | "/settings/diagnostics"
  | "/settings/performance";

/** The sections the panel renders, in tab order. */
export const SETTINGS_SECTION_IDS = [
  "board",
  "hermes",
  "models",
  "connections",
  "general",
  "system",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

/** Every id that used to be its own tab, pointing at the section that absorbed it. */
const SECTION_BY_ALIAS: Record<string, SettingsSectionId> = {
  archive: "board",
  skills: "board",
  friction: "hermes",
  providers: "connections",
  keybindings: "general",
  "source-control": "connections",
  updates: "connections",
  vps: "system",
  maintenance: "system",
  diagnostics: "system",
  performance: "system",
};

const SECTION_BY_SEGMENT: Record<string, SettingsSectionId> = {
  ...SECTION_BY_ALIAS,
  archived: "board",
  "skill-commands": "board",
  board: "board",
  hermes: "hermes",
  models: "models",
  connections: "connections",
  general: "general",
};

/** `settings:vps` → `system`; a live id maps to itself; anything else is null. */
export function resolveSettingsSection(id: string): SettingsSectionId | null {
  if ((SETTINGS_SECTION_IDS as ReadonlyArray<string>).includes(id)) {
    return id as SettingsSectionId;
  }
  return SECTION_BY_ALIAS[id] ?? null;
}

/** `/settings/skill-commands` → `board`; unknown or bare `/settings` → null. */
export function settingsSectionForPath(path: string): SettingsSectionId | null {
  const segment = path.replace(/^\/?settings\/?/, "").split("/")[0] ?? "";
  return SECTION_BY_SEGMENT[segment] ?? null;
}

/** `/settings/hermes` → `settings:hermes`; anything unknown lands on the panel. */
export function settingsStationForPath(path: string): string {
  const section = settingsSectionForPath(path);
  return section === null ? "settings" : `settings:${section}`;
}
