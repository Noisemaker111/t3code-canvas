import { ProviderInstanceId } from "@t3tools/contracts";
import { DownloadIcon, KeyRoundIcon, RotateCcwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  readBoardSettings,
  resetBoardSettings,
  subscribeBoardSettings,
  updateBoardSettings,
  type BoardSettings,
} from "../../lib/boardSettings";
import { requestHostConsoleCommand } from "../../lib/hostConsole";
import { usePrimarySettings } from "../../hooks/useSettings";
import { useUsageSnapshot } from "../../hooks/useUsageSnapshot";
import { providerUsageUnusableReason } from "../../lib/providerUsage";
import { resolveBoardInstanceId } from "../../lib/boardModelSelection";
import { CORE_BOARD_SKILL_IDS, isCoreBoardSkillId } from "./skillCommands/skillCommandsPage.logic";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
import { getProviderSummary } from "./providerStatus";
import { useProviderInstancePicker } from "./InstanceModelSelect";
import { ModelBenchPanel } from "./ModelBenchPanel";
import { SettingsRow, SettingsSection, settingsPageShell } from "./settingsLayout";

export function BoardSettingsPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const [settings, setSettings] = useState<BoardSettings>(() => readBoardSettings());
  const unified = usePrimarySettings();
  const skillCommands = unified.skillCommands;
  const usageSnapshot = useUsageSnapshot();
  const picker = useProviderInstancePicker();
  const { instances, isInstanceSelectable } = picker;

  useEffect(() => subscribeBoardSettings(setSettings), []);

  const instanceUsageReason = useCallback(
    (instanceId: string) => providerUsageUnusableReason(usageSnapshot.data, instanceId),
    [usageSnapshot.data],
  );

  const actionNeededInstances = useMemo(
    () =>
      instances.filter((entry) => {
        if (!entry.enabled) return false;
        if (!entry.installed) return true;
        if (entry.snapshot.auth.status === "unauthenticated") return true;
        return !isInstanceSelectable(entry) && Boolean(instanceUsageReason(entry.instanceId));
      }),
    [instanceUsageReason, instances, isInstanceSelectable],
  );

  const instanceCandidates = useMemo(
    () =>
      instances.map((entry) => ({
        instanceId: String(entry.instanceId),
        enabled: entry.enabled,
        selectable: isInstanceSelectable(entry),
      })),
    [instances, isInstanceSelectable],
  );

  const selectedInstanceId = useMemo(
    () =>
      ProviderInstanceId.make(
        resolveBoardInstanceId(instanceCandidates, [
          settings.hermesInstanceId,
          unified.defaultModelSelection?.instanceId,
        ]) ?? "codex",
      ),
    [instanceCandidates, settings.hermesInstanceId, unified.defaultModelSelection?.instanceId],
  );

  const selectedEntry = instances.find((entry) => entry.instanceId === selectedInstanceId);

  const modelOptions = useMemo(
    () => picker.modelOptionsFor(selectedEntry),
    [picker, selectedEntry],
  );

  const patch = useCallback((partial: Partial<BoardSettings>) => {
    setSettings(updateBoardSettings(partial));
  }, []);

  const skillEntries = useMemo(
    () =>
      Object.entries(skillCommands)
        .map(([id, command]) => ({ id, prompt: command.prompt }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    [skillCommands],
  );

  return settingsPageShell(
    embedded,
    <>
      <SettingsSection title="Hermes skills">
        {actionNeededInstances.length > 0 ? (
          <SettingsRow
            title="Needs setup"
            description="Providers configured for the board that cannot run yet. Open the root host terminal with the command preloaded, press Enter, then refresh provider status."
          >
            <div className="space-y-1.5 pb-3.5">
              {actionNeededInstances.map((entry) => {
                const driverMeta = DRIVER_OPTION_BY_VALUE[entry.driverKind];
                const summary = getProviderSummary(entry.snapshot);
                const installCommand = driverMeta?.installCommand;
                const loginCommand = driverMeta?.loginCommand;
                const needsInstall = !entry.installed;
                const needsLogin = entry.snapshot.auth.status === "unauthenticated";
                const usageReason = instanceUsageReason(entry.instanceId);
                return (
                  <div
                    key={entry.instanceId}
                    className="flex flex-wrap items-start justify-between gap-2 rounded-md bg-muted/40 px-2 py-1.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium">{entry.displayName}</p>
                      <p className="line-clamp-2 text-[11px] text-muted-foreground">
                        {summary.headline}
                        {summary.detail ? ` · ${summary.detail}` : ""}
                        {usageReason ? ` · ${usageReason}` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {needsLogin && loginCommand ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          className="h-7 gap-1"
                          onClick={() => requestHostConsoleCommand(loginCommand)}
                        >
                          <KeyRoundIcon className="size-3" />
                          Log in
                        </Button>
                      ) : null}
                      {installCommand ? (
                        <Button
                          type="button"
                          size="xs"
                          variant={needsInstall ? "outline" : "ghost"}
                          className="h-7 gap-1"
                          onClick={() => requestHostConsoleCommand(installCommand)}
                        >
                          <DownloadIcon className="size-3" />
                          {needsInstall ? "Install" : "Reinstall"}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </SettingsRow>
        ) : null}
        <ModelBenchPanel
          instanceId={selectedInstanceId}
          modelOptions={modelOptions}
          onApplied={() => setSettings(readBoardSettings())}
        />
      </SettingsSection>

      <SettingsSection title="Apply skills">
        <div className="space-y-0 border-t border-border/60 first:border-t-0">
          <div className="space-y-2 px-4 py-3.5 sm:px-5">
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              Apply skills runs each enabled skill{" "}
              <strong className="font-medium text-foreground/80">through the model</strong> (Hermes
              model selected by the Board benchmark when set) top → bottom — not string-append.
              Reorder with ↑↓.
            </p>
            <ol className="space-y-1 text-[11px] text-muted-foreground">
              <li>
                <span className="font-medium text-foreground/80">1. Skills (LLM)</span>
                {" — "}each skill is a model rewrite in list order
              </li>
              <li>
                <span className="font-medium text-foreground/80">2. Destination</span>
                {" — "}stay in Draft or move to Prompts
              </li>
            </ol>
          </div>

          <div className="border-t border-border/60 px-4 py-3.5 sm:px-5">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h3 className="text-[13px] font-semibold tracking-[-0.01em]">
                1. Skills (model pipeline)
              </h3>
              <span className="text-[11px] text-muted-foreground">Edit them below</span>
            </div>
            <p className="mb-2 text-[11px] text-muted-foreground">
              Routing is not a skill — Hermes structures and routes on the server. Each call here
              uses the skill text + current card body as an LLM instruction. Multi-thread structure
              uses fenced{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
                ```t3-threads
              </code>
              .
            </p>
            {skillEntries.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No Global Skills yet — add them below.
              </p>
            ) : (
              <ul className="max-h-64 space-y-0.5 overflow-y-auto">
                {(() => {
                  const enabled = settings.alwaysOnSkillIds;
                  const enabledSet = new Set(enabled);
                  const disabled = skillEntries.filter((s) => !enabledSet.has(s.id));
                  const orderedEnabled = enabled
                    .map((id) => skillEntries.find((s) => s.id === id))
                    .filter((s): s is (typeof skillEntries)[number] => Boolean(s));
                  const rows = [
                    ...orderedEnabled.map((s) => ({ skill: s, on: true as const })),
                    ...disabled.map((s) => ({ skill: s, on: false as const })),
                  ];
                  return rows.map(({ skill, on }) => {
                    const core = isCoreBoardSkillId(skill.id);
                    const enabledIndex = on ? enabled.indexOf(skill.id) : -1;
                    const effectiveOn = core || on;
                    return (
                      <li
                        key={skill.id}
                        className="flex items-center gap-1.5 rounded-md px-1 py-1.5 hover:bg-accent/40"
                      >
                        {effectiveOn && !core ? (
                          <div className="flex shrink-0 flex-col gap-0.5">
                            <button
                              type="button"
                              className="rounded px-1 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                              disabled={enabledIndex <= CORE_BOARD_SKILL_IDS.length}
                              aria-label={`Move /${skill.id} up`}
                              onClick={() => {
                                if (enabledIndex <= CORE_BOARD_SKILL_IDS.length) return;
                                const next = [...enabled];
                                const tmp = next[enabledIndex - 1]!;
                                next[enabledIndex - 1] = next[enabledIndex]!;
                                next[enabledIndex] = tmp;
                                patch({ alwaysOnSkillIds: next });
                              }}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="rounded px-1 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                              disabled={enabledIndex < 0 || enabledIndex >= enabled.length - 1}
                              aria-label={`Move /${skill.id} down`}
                              onClick={() => {
                                if (enabledIndex < 0 || enabledIndex >= enabled.length - 1) return;
                                const next = [...enabled];
                                const tmp = next[enabledIndex + 1]!;
                                next[enabledIndex + 1] = next[enabledIndex]!;
                                next[enabledIndex] = tmp;
                                patch({ alwaysOnSkillIds: next });
                              }}
                            >
                              ↓
                            </button>
                          </div>
                        ) : (
                          <span className="w-5 shrink-0" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            {effectiveOn ? (
                              <span className="text-[10px] tabular-nums text-muted-foreground">
                                {enabledIndex >= 0 ? enabledIndex + 1 : "·"}.
                              </span>
                            ) : null}
                            <span className="truncate font-mono text-[12px] font-medium">
                              /{skill.id}
                            </span>
                            {core ? (
                              <span className="rounded bg-muted px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                                Core
                              </span>
                            ) : null}
                          </div>
                          <div className="truncate text-[10px] text-muted-foreground">
                            {skill.prompt.slice(0, 100)}
                          </div>
                        </div>
                        <Switch
                          checked={effectiveOn}
                          disabled={core}
                          onCheckedChange={(checked) => {
                            if (core) return;
                            if (checked) {
                              patch({
                                alwaysOnSkillIds: [...settings.alwaysOnSkillIds, skill.id],
                              });
                            } else {
                              patch({
                                alwaysOnSkillIds: settings.alwaysOnSkillIds.filter(
                                  (id) => id !== skill.id,
                                ),
                              });
                            }
                          }}
                          aria-label={
                            core
                              ? `Core skill /${skill.id} always runs`
                              : `Include /${skill.id} in Apply skills`
                          }
                        />
                      </li>
                    );
                  });
                })()}
              </ul>
            )}
          </div>

          <div className="border-t border-border/60 px-4 py-3.5 sm:px-5">
            <h3 className="mb-1 text-[13px] font-semibold tracking-[-0.01em]">
              2. After Apply skills
            </h3>
            <p className="mb-2.5 text-[11px] text-muted-foreground">
              Where the card goes when the pipeline finishes.
            </p>
            <div className="grid gap-1.5 sm:grid-cols-2">
              <button
                type="button"
                className={
                  !settings.autoPromoteDraftAfterSkills
                    ? "rounded-lg border border-primary bg-primary/10 px-3 py-2 text-left"
                    : "rounded-lg bg-raised/40 px-3 py-2 text-left hover:bg-accent/40"
                }
                onClick={() => patch({ autoPromoteDraftAfterSkills: false })}
              >
                <span className="block text-[12px] font-medium">Stay in Draft</span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  Keep editing; you move it later.
                </span>
              </button>
              <button
                type="button"
                className={
                  settings.autoPromoteDraftAfterSkills
                    ? "rounded-lg border border-primary bg-primary/10 px-3 py-2 text-left"
                    : "rounded-lg bg-raised/40 px-3 py-2 text-left hover:bg-accent/40"
                }
                onClick={() => patch({ autoPromoteDraftAfterSkills: true })}
              >
                <span className="block text-[12px] font-medium">Move to Prompts</span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  Ready queue for launch / Active.
                </span>
              </button>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="Capture & launch">
        <SettingsRow
          title="Confirm before Active"
          description="Ask before drag/launch starts a coding thread."
          control={
            <Switch
              checked={settings.confirmBeforeLaunchActive}
              onCheckedChange={(checked) => patch({ confirmBeforeLaunchActive: Boolean(checked) })}
            />
          }
        />
        <SettingsRow
          title="Fix it opens"
          description="What the Fix it button on an error starts."
          control={
            <div className="flex gap-1.5">
              <Button
                onClick={() => patch({ errorFixMode: "card" })}
                size="sm"
                variant={settings.errorFixMode === "card" ? "default" : "outline"}
              >
                A card
              </Button>
              <Button
                onClick={() => patch({ errorFixMode: "thread" })}
                size="sm"
                variant={settings.errorFixMode === "thread" ? "default" : "outline"}
              >
                A thread
              </Button>
            </div>
          }
        />
        <SettingsRow
          title="Show the AI usage ring"
          description="Provider usage/burn-rate panel in the board header."
          control={
            <Switch
              checked={settings.showUsageIndicator}
              onCheckedChange={(checked) => patch({ showUsageIndicator: Boolean(checked) })}
            />
          }
        />
      </SettingsSection>

      <div className="flex justify-end px-1">
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => setSettings(resetBoardSettings())}
        >
          <RotateCcwIcon className="size-3.5" />
          Reset Board settings
        </Button>
      </div>
    </>,
  );
}
