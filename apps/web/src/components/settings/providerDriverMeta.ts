import {
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  GrokSettings,
  OpenCodeSettings,
  ProviderDriverKind,
} from "@t3tools/contracts";
import type * as Schema from "effect/Schema";
import { ClaudeAI, CursorIcon, GrokIcon, type Icon, OpenAI, OpenCodeIcon } from "../Icons";

type ProviderSettingsSchema = {
  readonly fields: Readonly<Record<string, Schema.Top>>;
} & Schema.Top;

/**
 * Browser-safe provider definition. This is deliberately shaped like the
 * future provider package client export: the core web app gets a schema with
 * field annotations plus provider-level presentation metadata, then renders
 * settings generically.
 */
export interface ProviderClientDefinition {
  readonly value: ProviderDriverKind;
  readonly label: string;
  readonly icon: Icon;
  readonly settingsSchema: ProviderSettingsSchema;
  /**
   * Optional short label rendered as a `variant="warning"` badge next to
   * the instance title. Used to flag drivers that still ship under an
   * early-access or preview gate — the flag is a property of the driver
   * kind (not a specific instance), so every instance of that driver —
   * built-in default or custom — advertises the same marker.
   */
  readonly badgeLabel?: string;
  /** Terminal command to authenticate the CLI (copied for the user to run). */
  readonly loginCommand?: string;
  /** Terminal command to install / reinstall the CLI (copied for the user to run). */
  readonly installCommand?: string;
}

export const PROVIDER_CLIENT_DEFINITIONS: readonly ProviderClientDefinition[] = [
  {
    value: ProviderDriverKind.make("codex"),
    label: "Codex",
    icon: OpenAI,
    settingsSchema: CodexSettings,
    loginCommand: "codex login",
    installCommand: "npm install -g @openai/codex@latest",
  },
  {
    value: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    icon: ClaudeAI,
    settingsSchema: ClaudeSettings,
    loginCommand: "claude auth login",
    // Anthropic's native installer. The npm package needs a reachable registry
    // and shares the global node prefix; when egress is down its resolver hangs
    // instead of failing, and this command runs in the one host console.
    //
    // `bash -c "$(curl …)"`, never `curl … | bash`: piped, the installer's stdin
    // is the pipe rather than the pty, so the moment it asks anything — and a
    // reinstall over an existing install does — nothing the human types can
    // reach it and the host console sits there forever.
    installCommand: 'bash -c "$(curl -fsSL https://claude.ai/install.sh)"',
  },
  {
    value: ProviderDriverKind.make("cursor"),
    label: "Cursor",
    icon: CursorIcon,
    badgeLabel: "Early Access",
    settingsSchema: CursorSettings,
    loginCommand: "cursor-agent login",
    installCommand: 'bash -c "$(curl -fsS https://cursor.com/install)"',
  },
  {
    value: ProviderDriverKind.make("grok"),
    label: "Grok",
    icon: GrokIcon,
    badgeLabel: "Early Access",
    settingsSchema: GrokSettings,
    loginCommand: "grok auth login",
    // x.ai's own installer, the one the box provisions with. `@xai/grok` is not
    // a package that exists — the button 404'd on npm.
    installCommand: 'bash -c "$(curl -fsSL https://x.ai/cli/install.sh)"',
  },
  {
    value: ProviderDriverKind.make("opencode"),
    label: "OpenCode",
    icon: OpenCodeIcon,
    settingsSchema: OpenCodeSettings,
    loginCommand: "opencode auth login",
    installCommand: "npm install -g opencode-ai@latest",
  },
];

export const PROVIDER_CLIENT_DEFINITION_BY_VALUE: Partial<
  Record<ProviderDriverKind, ProviderClientDefinition>
> = Object.fromEntries(
  PROVIDER_CLIENT_DEFINITIONS.map((definition) => [definition.value, definition]),
);

export const DRIVER_OPTIONS = PROVIDER_CLIENT_DEFINITIONS;
export const DRIVER_OPTION_BY_VALUE = PROVIDER_CLIENT_DEFINITION_BY_VALUE;
export type DriverOption = ProviderClientDefinition;

/**
 * Look up the driver metadata for an instance's `driver` field. Accepts
 * Returns `undefined` for fork / unknown drivers so callers can decide how
 * to render them — typically by falling back to a generic card.
 */
export function getDriverOption(driver: ProviderDriverKind | undefined): DriverOption | undefined {
  if (driver === undefined) return undefined;
  return PROVIDER_CLIENT_DEFINITION_BY_VALUE[driver];
}
