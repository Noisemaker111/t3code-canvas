"use client";

import { LoaderIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useDeferredValue, useMemo, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";

import { useRefreshServerProviders } from "../../../hooks/useRefreshServerProviders";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../../hooks/useSettings";
import { primaryServerProvidersAtom } from "../../../state/server";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { getDriverOption } from "../providerDriverMeta";
import { ProviderLastChecked } from "../SettingsPanels";
import { SettingsSection, settingsPageShell } from "../settingsLayout";
import { ModelRolesSection } from "./ModelRolesSection";
import { ModelRosterSection } from "./ModelRosterSection";
import { ProviderModelGroup } from "./ProviderModelGroup";
import {
  buildCustomModelsPatch,
  buildProviderFavoriteModelsPatch,
  buildProviderInstanceRows,
  buildProviderModelPreferencesPatch,
  getVisibleProviderSettings,
} from "./modelsPage.logic";

const EMPTY_PREFERENCES = { hiddenModels: [], modelOrder: [] } as const;

export function ModelsSettingsPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const { refresh, isRefreshing, lastCheckedAt } = useRefreshServerProviders();
  const [searchQuery, setSearchQuery] = useState("");
  // Typing stays responsive even while every provider group re-filters.
  const deferredQuery = useDeferredValue(searchQuery);

  const rows = useMemo(
    () => buildProviderInstanceRows(settings, getVisibleProviderSettings(serverProviders)),
    [serverProviders, settings],
  );

  return settingsPageShell(
    embedded,
    <>
      <ModelRosterSection />

      <ModelRolesSection />

      <SettingsSection
        title="Models"
        headerAction={
          <div className="flex items-center gap-1.5">
            <Button
              render={<Link to="/kanban" search={{ station: "settings:connections" }} />}
              size="xs"
              variant="outline"
              className="h-7"
            >
              Manage providers
            </Button>
            <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
            <Button
              size="icon-xs"
              variant="ghost"
              className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
              disabled={isRefreshing}
              onClick={() => refresh()}
              title="Refresh models"
              aria-label="Refresh models"
            >
              {isRefreshing ? (
                <LoaderIcon className="size-3 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-3" />
              )}
            </Button>
          </div>
        }
      >
        <div className="border-b border-border/60 px-3 py-2.5 sm:px-4">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Filter models — matching providers open automatically"
              spellCheck={false}
              className="pl-8"
              aria-label="Filter models"
            />
          </div>
        </div>

        {rows.map((row) => {
          const liveProvider = serverProviders.find(
            (candidate) => candidate.instanceId === row.instanceId,
          );
          const modelPreferences =
            settings.providerModelPreferences?.[row.instanceId] ?? EMPTY_PREFERENCES;
          const favoriteModels = Arr.filterMap(settings.favorites ?? [], (favorite) =>
            favorite.provider === row.instanceId ? Result.succeed(favorite.model) : Result.failVoid,
          );

          return (
            <ProviderModelGroup
              key={row.instanceId}
              row={row}
              driverOption={getDriverOption(row.driver)}
              liveProvider={liveProvider}
              hiddenModels={modelPreferences.hiddenModels}
              favoriteModels={favoriteModels}
              modelOrder={modelPreferences.modelOrder}
              searchQuery={deferredQuery}
              onHiddenModelsChange={(hiddenModels) =>
                updateSettings(
                  buildProviderModelPreferencesPatch(settings, row.instanceId, {
                    ...modelPreferences,
                    hiddenModels,
                  }),
                )
              }
              onFavoriteModelsChange={(nextFavoriteModels) =>
                updateSettings(
                  buildProviderFavoriteModelsPatch(settings, row.instanceId, nextFavoriteModels),
                )
              }
              onModelOrderChange={(modelOrder) =>
                updateSettings(
                  buildProviderModelPreferencesPatch(settings, row.instanceId, {
                    ...modelPreferences,
                    modelOrder,
                  }),
                )
              }
              onCustomModelsChange={(nextCustomModels) =>
                updateSettings(buildCustomModelsPatch(settings, row, nextCustomModels))
              }
            />
          );
        })}
      </SettingsSection>
    </>,
  );
}
