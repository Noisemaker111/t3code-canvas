"use client";

import { DownloadIcon, ExternalLinkIcon, PlusIcon, SparklesIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { SkillCommandId } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../../hooks/useSettings";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { toastManager } from "../../ui/toast";
import { SettingsSection, settingsPageShell } from "../settingsLayout";
import { SkillCommandRow } from "./SkillCommandRow";
import {
  buildSkillCommandsPatch,
  fetchSkillMarkdownFromSkillsSh,
  getCoreBoardStarterSkills,
  isCoreBoardSkillId,
  isNaturalLanguageSkillQuery,
  isReservedSkillCommandName,
  MAX_SKILL_COMMAND_PROMPT_LENGTH,
  normalizeSkillCommandId,
  parseSkillsShRef,
  searchSkillsSh,
  STARTER_GLOBAL_SKILLS,
  type SkillsShSearchHit,
} from "./skillCommandsPage.logic";

const DEFAULT_SKILL_IDS = STARTER_GLOBAL_SKILLS.map((skill) => skill.id).join(" · ");
const CORE_ORDER = ["structure", "model-router"] as const;

export function SkillCommandsSettingsPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const skillCommands = usePrimarySettings((settings) => settings.skillCommands);
  const updateSettings = useUpdatePrimarySettings();

  const [nameInput, setNameInput] = useState("");
  const [promptInput, setPromptInput] = useState("");
  const [importInput, setImportInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [searchHits, setSearchHits] = useState<ReadonlyArray<SkillsShSearchHit>>([]);
  const [searching, setSearching] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);

  useEffect(() => {
    const next = { ...skillCommands };
    let added = 0;
    for (const starter of getCoreBoardStarterSkills()) {
      const id = starter.id as SkillCommandId;
      if (next[id]?.prompt?.trim()) continue;
      next[id] = { prompt: starter.prompt };
      added += 1;
    }
    if (added === 0) return;
    updateSettings(buildSkillCommandsPatch(next));
  }, [skillCommands, updateSettings]);

  const entries = Object.entries(skillCommands).sort(([a], [b]) => {
    const aCore = isCoreBoardSkillId(a);
    const bCore = isCoreBoardSkillId(b);
    if (aCore && !bCore) return -1;
    if (!aCore && bCore) return 1;
    if (aCore && bCore) {
      return (
        (CORE_ORDER as ReadonlyArray<string>).indexOf(a) -
        (CORE_ORDER as ReadonlyArray<string>).indexOf(b)
      );
    }
    return a.localeCompare(b);
  });

  const commitSkill = (id: string, prompt: string, { overwrite = false } = {}) => {
    if (isReservedSkillCommandName(id)) {
      throw new Error(`/${id} is reserved.`);
    }
    if (!overwrite && skillCommands[id as SkillCommandId] !== undefined) {
      throw new Error(`/${id} already exists.`);
    }
    updateSettings(
      buildSkillCommandsPatch({
        ...skillCommands,
        [id]: { prompt },
      }),
    );
  };

  const handleAdd = () => {
    const normalized = normalizeSkillCommandId(nameInput);
    if (!normalized) {
      setError("Name must start with a letter (letters, digits, - and _ only).");
      return;
    }
    if (isReservedSkillCommandName(normalized)) {
      setError(`/${normalized} is reserved.`);
      return;
    }
    if (skillCommands[normalized as SkillCommandId] !== undefined) {
      setError(`/${normalized} already exists.`);
      return;
    }
    const trimmedPrompt = promptInput.trim();
    if (!trimmedPrompt) {
      setError("Enter the skill text.");
      return;
    }

    try {
      commitSkill(normalized, trimmedPrompt);
      setNameInput("");
      setPromptInput("");
      setError(null);
      setShowAddForm(false);
    } catch (addError: unknown) {
      setError(addError instanceof Error ? addError.message : "Could not add skill.");
    }
  };

  const handleSave = (id: string, nextPrompt: string) => {
    updateSettings(
      buildSkillCommandsPatch({
        ...skillCommands,
        [id]: { prompt: nextPrompt },
      }),
    );
  };

  const handleDelete = (id: string) => {
    const rest = { ...skillCommands };
    delete rest[id as SkillCommandId];
    updateSettings(buildSkillCommandsPatch(rest));
  };

  const importByRef = async (refText: string) => {
    const result = await fetchSkillMarkdownFromSkillsSh(refText);
    if (isReservedSkillCommandName(result.id)) {
      throw new Error(`/${result.id} is reserved.`);
    }
    const exists = skillCommands[result.id as SkillCommandId] !== undefined;
    commitSkill(result.id, result.prompt, { overwrite: exists });
    setImportInput("");
    setSearchHits([]);
    toastManager.add({
      type: "success",
      title: exists ? `Updated /${result.id}` : `Imported /${result.id}`,
      description: "From skills.sh / GitHub SKILL.md",
    });
  };

  const handleImportOrSearch = async () => {
    setImportError(null);
    setSearchHits([]);
    const raw = importInput.trim();
    if (raw.length === 0) return;

    if (parseSkillsShRef(raw)) {
      setImporting(true);
      try {
        await importByRef(raw);
      } catch (importErr: unknown) {
        setImportError(importErr instanceof Error ? importErr.message : "Import failed.");
      } finally {
        setImporting(false);
      }
      return;
    }

    if (isNaturalLanguageSkillQuery(raw)) {
      setSearching(true);
      try {
        const hits = await searchSkillsSh(raw);
        if (hits.length === 0) {
          setImportError("No skills matched. Try different keywords or paste owner/repo/skill.");
          return;
        }
        setSearchHits(hits.slice(0, 12));
      } catch (searchErr: unknown) {
        setImportError(
          searchErr instanceof Error
            ? searchErr.message
            : "Search failed. Is the T3 server running?",
        );
      } finally {
        setSearching(false);
      }
    }
  };

  const handlePickSearchHit = async (hit: SkillsShSearchHit) => {
    setImportError(null);
    setImporting(true);
    try {
      await importByRef(`${hit.owner}/${hit.repo}/${hit.skillId}`);
    } catch (importErr: unknown) {
      setImportError(importErr instanceof Error ? importErr.message : "Import failed.");
    } finally {
      setImporting(false);
    }
  };

  const handleAddDefaultSkills = () => {
    const next = { ...skillCommands };
    let added = 0;
    let refreshed = 0;
    for (const starter of STARTER_GLOBAL_SKILLS) {
      const id = starter.id as SkillCommandId;
      if (next[id] === undefined) {
        next[id] = { prompt: starter.prompt };
        added += 1;
      } else {
        // Keep custom skills; overwrite built-in starter wording when ids match.
        next[id] = { prompt: starter.prompt };
        refreshed += 1;
      }
    }
    updateSettings(buildSkillCommandsPatch(next));
    toastManager.add({
      type: "success",
      title:
        added > 0
          ? `Added ${added} default skill${added === 1 ? "" : "s"}`
          : "Refreshed default skills",
      description:
        refreshed > 0
          ? `Updated ${refreshed} starter skill${refreshed === 1 ? "" : "s"} to latest wording. ${DEFAULT_SKILL_IDS}`
          : DEFAULT_SKILL_IDS,
    });
  };

  const importBusy = importing || searching;
  const canSubmitAdd = nameInput.trim().length > 0 && promptInput.trim().length > 0 && !importBusy;

  return settingsPageShell(
    embedded,
    <>
      <SettingsSection
        title="Global Skills"
        headerAction={
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="xs" onClick={handleAddDefaultSkills}>
              <SparklesIcon className="size-3.5" />
              Defaults
            </Button>
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                setShowAddForm((open) => !open);
                setError(null);
              }}
            >
              <PlusIcon className="size-3.5" />
              New
            </Button>
          </div>
        }
      >
        {showAddForm ? (
          <div className="space-y-3 border-b border-border/60 px-4 py-3 sm:px-5">
            <div className="grid gap-2 sm:grid-cols-[7rem_minmax(0,1fr)] sm:items-center">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="new-skill-name">
                Slash name
              </label>
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 text-sm text-muted-foreground">/</span>
                <Input
                  id="new-skill-name"
                  value={nameInput}
                  onChange={(event) => {
                    setNameInput(event.target.value);
                    if (error) setError(null);
                  }}
                  placeholder="structure"
                  spellCheck={false}
                  className="h-8 font-mono text-sm"
                />
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-[7rem_minmax(0,1fr)] sm:items-start">
              <label
                className="pt-1.5 text-xs font-medium text-muted-foreground"
                htmlFor="new-skill-body"
              >
                Instructions
              </label>
              <Textarea
                id="new-skill-body"
                value={promptInput}
                onChange={(event) => {
                  setPromptInput(event.target.value.slice(0, MAX_SKILL_COMMAND_PROMPT_LENGTH));
                  if (error) setError(null);
                }}
                placeholder="What the model should do with the card text (appended as INPUT automatically)…"
                spellCheck
                rows={5}
                className="min-h-[7.5rem] resize-y text-sm"
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 sm:pl-[7.75rem]">
              <span className="text-[11px] text-muted-foreground">
                {promptInput.trim().length.toLocaleString()}/
                {MAX_SKILL_COMMAND_PROMPT_LENGTH.toLocaleString()}
              </span>
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    setShowAddForm(false);
                    setError(null);
                  }}
                >
                  Cancel
                </Button>
                <Button type="button" size="xs" disabled={!canSubmitAdd} onClick={handleAdd}>
                  Save skill
                </Button>
              </div>
            </div>
            {error ? <p className="text-xs text-destructive sm:pl-[7.75rem]">{error}</p> : null}
          </div>
        ) : null}

        {entries.length === 0 && !showAddForm ? (
          <div className="px-4 py-8 text-center sm:px-5">
            <p className="text-sm text-muted-foreground">No skills yet.</p>
            <p className="mt-1 text-xs text-muted-foreground/70">
              Add defaults, import from{" "}
              <a
                href="https://skills.sh"
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              >
                skills.sh
              </a>
              , or create one.
            </p>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              <Button variant="outline" size="sm" onClick={handleAddDefaultSkills}>
                <SparklesIcon className="size-3.5" />
                Add default skills
              </Button>
              <Button variant="outline" size="sm" onClick={() => setShowAddForm(true)}>
                <PlusIcon className="size-3.5" />
                New skill
              </Button>
            </div>
          </div>
        ) : (
          entries.map((entry) => (
            <SkillCommandRow
              key={entry[0]}
              id={entry[0]}
              prompt={entry[1].prompt}
              locked={isCoreBoardSkillId(entry[0])}
              {...(isCoreBoardSkillId(entry[0]) ? { badge: "Core" } : {})}
              onSave={(nextPrompt) => handleSave(entry[0], nextPrompt)}
              onDelete={() => {
                if (isCoreBoardSkillId(entry[0])) return;
                handleDelete(entry[0]);
              }}
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection title="Import">
        <div className="space-y-2.5 px-4 py-3 sm:px-5">
          <p className="text-xs text-muted-foreground">
            Keywords or{" "}
            <code className="rounded bg-muted/50 px-1 py-0.5 font-mono text-[11px]">
              owner/repo@skill
            </code>
            .{" "}
            <a
              href="https://skills.sh"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline"
            >
              skills.sh
              <ExternalLinkIcon className="size-3" />
            </a>
          </p>
          <div className="flex gap-2">
            <Input
              value={importInput}
              onChange={(event) => {
                setImportInput(event.target.value);
                if (importError) setImportError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleImportOrSearch();
                }
              }}
              placeholder="research prompt · or mattpocock/skills@research"
              spellCheck
              aria-label="skills.sh search or skill reference"
              className="h-9 min-w-0 flex-1"
            />
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={importBusy || importInput.trim().length === 0}
              onClick={() => void handleImportOrSearch()}
            >
              {searching ? (
                "…"
              ) : importing ? (
                "…"
              ) : parseSkillsShRef(importInput) ? (
                <>
                  <DownloadIcon className="size-3.5" />
                  Import
                </>
              ) : (
                "Search"
              )}
            </Button>
          </div>
          {importError ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">
              {importError}
            </p>
          ) : null}
          {searchHits.length > 0 ? (
            <ul className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-border/60 bg-muted/20 p-1">
              {searchHits.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    disabled={importing}
                    onClick={() => void handlePickSearchHit(hit)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left",
                      "transition-colors hover:bg-background disabled:opacity-50",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-[12px] font-medium text-foreground">
                        {hit.source}@{hit.skillId}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {hit.installs.toLocaleString()} installs
                      </span>
                    </span>
                    <DownloadIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </SettingsSection>
    </>,
  );
}
