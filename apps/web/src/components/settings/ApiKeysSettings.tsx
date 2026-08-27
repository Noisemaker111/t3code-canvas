"use client";

import { useState } from "react";

import { Button } from "../ui/button";
import { SettingsRow, SettingsSection, settingsPageShell } from "./settingsLayout";
import {
  saveUsageCredential,
  usageCredentialStatus,
  useUsageCredentials,
  type UsageCredentialStatus,
} from "./usageCredentials";

type ApiKeyField = {
  readonly family: string;
  readonly title: string;
  readonly description: string;
  readonly consoleUrl: string;
};

/**
 * Families the server accepts a pasted key for (`STORED_CREDENTIAL_PROVIDERS`).
 * Descriptions say what the key actually buys — OpenRouter drives runs as well
 * as usage; the CLI-backed families are usage reporting only.
 */
const API_KEY_FIELDS: ReadonlyArray<ApiKeyField> = [
  {
    family: "openrouter",
    title: "OpenRouter",
    description:
      "Model catalog, pricing, and usage — and the key Hermes, the Auto Router, the model bench, and OpenCode runs use to reach OpenRouter models.",
    consoleUrl: "https://openrouter.ai/keys",
  },
  {
    family: "grok",
    title: "Grok (xAI)",
    description: "Usage reporting only. Agent runs use the Grok CLI login.",
    consoleUrl: "https://console.x.ai",
  },
  {
    family: "cursor",
    title: "Cursor",
    description: "Usage reporting only. Agent runs use the Cursor CLI login.",
    consoleUrl: "https://cursor.com/dashboard",
  },
];

function sourceLabel(status: UsageCredentialStatus | null, error: string | null) {
  if (error) return `Status unavailable — ${error}`;
  if (!status) return "Loading…";
  if (!status.source) return "No key — this provider cannot be reached or reported on.";
  if (status.source === "stored token") return "Key set here.";
  return `Using ${status.source} — a key saved here would be ignored until that is cleared.`;
}

function ApiKeyRow({ field }: { readonly field: ApiKeyField }) {
  const { statuses, error } = useUsageCredentials();
  const status = usageCredentialStatus(statuses, field.family);
  const [draft, setDraft] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = async (token: string | null) => {
    setIsSaving(true);
    setSaveError(null);
    try {
      await saveUsageCredential(field.family, token);
      setDraft("");
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <SettingsRow
      title={field.title}
      description={`${field.description} ${sourceLabel(status, error)}${
        saveError ? ` Save failed — ${saveError}.` : ""
      }`}
      control={
        <div className="flex flex-col items-end gap-2">
          <input
            type="password"
            spellCheck={false}
            autoComplete="off"
            aria-label={`${field.title} API key`}
            placeholder="Paste a key"
            className="h-8 w-64 rounded-md bg-raised px-2 font-mono text-xs outline-none focus:border-ring"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex items-center gap-1.5">
            <a
              href={field.consoleUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-primary hover:underline"
            >
              Get a key
            </a>
            {status?.source === "stored token" ? (
              <Button
                size="xs"
                variant="ghost"
                className="text-muted-foreground"
                aria-label={`Clear ${field.title} API key`}
                disabled={isSaving}
                onClick={() => void save(null)}
              >
                Clear
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              aria-label={`Save ${field.title} API key`}
              disabled={isSaving || draft.trim().length === 0}
              onClick={() => void save(draft)}
            >
              Save
            </Button>
          </div>
        </div>
      }
    />
  );
}

/**
 * The one place to enter provider API keys. Lives beside Providers rather than
 * inside a provider card so a key can be set before (or without) a matching
 * provider instance existing — OpenRouter has no driver of its own.
 */
export function ApiKeysSettingsPanel({ embedded = false }: { embedded?: boolean } = {}) {
  return settingsPageShell(
    embedded,
    <SettingsSection title="API keys">
      {API_KEY_FIELDS.map((field) => (
        <ApiKeyRow key={field.family} field={field} />
      ))}
    </SettingsSection>,
  );
}
