import { RotateCcwIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useState, type ComponentType } from "react";

import { ApiKeysSettingsPanel } from "../../settings/ApiKeysSettings";
import { BoardSettingsPanel } from "../../settings/BoardSettingsPanel";
import { CanvasSettingsPanel } from "../../settings/CanvasSettings";
import { ConnectionsSettings } from "../../settings/ConnectionsSettings";
import { DiagnosticsSettingsPanel } from "../../settings/DiagnosticsSettings";
import { FrictionPanel } from "../../settings/FrictionPanel";
import { HermesSettingsPanel } from "../../settings/HermesSettingsPanel";
import { KeybindingsSettingsPanel } from "../../settings/KeybindingsSettings";
import { MaintenancePanel } from "../../settings/MaintenancePanel";
import { PerformanceSettingsPanel } from "../../settings/PerformanceSettings";
import { ModelsSettingsPanel } from "../../settings/models/ModelsSettingsPanel";
import {
  ArchivedThreadsPanel,
  GeneralSettingsPanel,
  ProviderSettingsPanel,
  useSettingsRestore,
} from "../../settings/SettingsPanels";
import { SettingsSearchResults } from "../../settings/SettingsSearchResults";
import { SourceControlSettingsPanel } from "../../settings/SourceControlSettings";
import {
  resolveSettingsSection,
  settingsSectionForPath,
  type SettingsSectionId,
} from "../../settings/settingsStations";
import { SettingsLazyPanel, SettingsPageContainer } from "../../settings/settingsLayout";
import { SkillCommandsSettingsPanel } from "../../settings/skillCommands/SkillCommandsSettingsPanel";
import { UpdateSettingsPanel } from "../../settings/UpdateSettings";
import { VpsSettingsPanel } from "../../settings/VpsSettings";
import { useCanvasStationStore } from "../../../canvasStationStore";
import { useCompactLayout } from "./compactLayout";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { ScrollArea } from "../../ui/scroll-area";
import { cn } from "~/lib/utils";

/**
 * Settings as a place on the canvas — the only settings surface.
 *
 * Six sections, each one concern: what the board does, the brain that drives
 * it, the models it runs on, what this client is connected to, how the app
 * behaves, and the box underneath. A section stacks its panels under their own
 * headings — a panel is never its own tab. `/settings/*` and the pre-merge
 * section ids are redirects into this table (settingsStations.ts).
 */
type EmbeddablePanel = ComponentType<{ embedded?: boolean }>;

const SECTIONS: ReadonlyArray<{
  readonly id: SettingsSectionId;
  readonly label: string;
  readonly panels: ReadonlyArray<EmbeddablePanel>;
}> = [
  {
    id: "board",
    label: "Board",
    panels: [
      CanvasSettingsPanel,
      BoardSettingsPanel,
      SkillCommandsSettingsPanel,
      ArchivedThreadsPanel,
    ],
  },
  { id: "hermes", label: "Hermes", panels: [HermesSettingsPanel, FrictionPanel] },
  { id: "models", label: "Models", panels: [ModelsSettingsPanel] },
  {
    id: "connections",
    label: "Connections",
    panels: [
      ProviderSettingsPanel,
      ApiKeysSettingsPanel,
      SourceControlSettingsPanel,
      ConnectionsSettings,
      UpdateSettingsPanel,
    ],
  },
  {
    id: "general",
    label: "General",
    panels: [GeneralSettingsPanel, KeybindingsSettingsPanel],
  },
  {
    id: "system",
    label: "System",
    panels: [
      VpsSettingsPanel,
      MaintenancePanel,
      DiagnosticsSettingsPanel,
      PerformanceSettingsPanel,
    ],
  },
];

function RestoreDefaultsButton({ onRestored }: { readonly onRestored: () => void }) {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored);
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={changedSettingLabels.length === 0}
      onClick={() => void restoreDefaults()}
    >
      <RotateCcwIcon className="size-3.5" />
      Restore defaults
    </Button>
  );
}

export function SettingsPanel({ opened }: { readonly opened: boolean }) {
  const [sectionId, setSectionId] = useState<SettingsSectionId>(SECTIONS[0]!.id);
  const [query, setQuery] = useState("");
  // Remount the pane after a restore so every row rereads its default.
  const [restoreSignal, setRestoreSignal] = useState(0);
  // `?station=settings:hermes` is a deep link to a section, not a second panel.
  const requested = useCanvasStationStore((state) =>
    state.station?.kind === "settings" ? state.station.entityId : "",
  );
  useEffect(() => {
    const target = requested.length > 0 ? resolveSettingsSection(requested) : null;
    if (target !== null) {
      setSectionId(target);
      setQuery("");
    }
  }, [requested]);
  const section = SECTIONS.find((entry) => entry.id === sectionId) ?? SECTIONS[0]!;

  // A 10rem sidebar is a fifth of a laptop and nearly half a phone, which left
  // the settings themselves in a 230px gutter. Narrow, the sections go across
  // the top as a scrollable row and the panel gets the whole width.
  const compact = useCompactLayout();

  return (
    <div className={cn("flex min-h-0 flex-1", compact && "flex-col")}>
      <nav
        className={cn(
          "flex shrink-0 gap-0.5 border-border",
          compact
            ? "overflow-x-auto border-b p-1.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            : "w-40 flex-col overflow-y-auto border-r p-2",
        )}
      >
        {SECTIONS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => {
              setSectionId(entry.id);
              setQuery("");
            }}
            className={cn(
              "rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
              compact
                ? "h-8 shrink-0 whitespace-nowrap px-2.5 text-[13px]"
                : "px-2 py-1 text-left text-xs",
              entry.id === section.id && query.length === 0 && "bg-accent text-foreground",
            )}
          >
            {entry.label}
          </button>
        ))}
      </nav>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        {opened ? (
          <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3 py-2">
            <div className="relative min-w-0 flex-1 max-w-md">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search settings…"
                aria-label="Search settings"
                className="h-8 pl-7 pr-8 text-xs"
              />
              {query.length > 0 ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  className="absolute top-1/2 right-1.5 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                  onClick={() => setQuery("")}
                >
                  <XIcon className="size-3.5" />
                </button>
              ) : null}
            </div>
            <RestoreDefaultsButton onRestored={() => setRestoreSignal((n) => n + 1)} />
          </div>
        ) : null}
        <ScrollArea className="min-h-0 flex-1">
          <div className={cn(compact ? "p-3 pb-[max(1rem,env(safe-area-inset-bottom))]" : "p-4")}>
            {!opened ? (
              <p className="text-sm text-muted-foreground">
                Zoom in — the panels build when you look at them.
              </p>
            ) : query.trim().length > 0 ? (
              <SettingsSearchResults
                query={query}
                onSelect={() => setQuery("")}
                onNavigate={(match) => {
                  const target = settingsSectionForPath(match.path);
                  if (target !== null) setSectionId(target);
                }}
              />
            ) : (
              <SettingsPageContainer key={`${section.id}:${restoreSignal}`}>
                {section.panels.map((Panel, index) =>
                  index === 0 ? (
                    <Panel key={index} embedded />
                  ) : (
                    <SettingsLazyPanel key={index}>
                      <Panel embedded />
                    </SettingsLazyPanel>
                  ),
                )}
              </SettingsPageContainer>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
