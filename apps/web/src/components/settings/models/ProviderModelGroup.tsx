"use client";

import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { isProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { normalizeCustomModelSlug } from "@t3tools/shared/model";

import { cn } from "../../../lib/utils";
import { sortModelsForProviderInstance } from "../../../modelOrdering";
import { MAX_CUSTOM_MODEL_LENGTH } from "../../../modelSelection";
import { ProviderInstanceIcon } from "../../chat/ProviderInstanceIcon";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import type { DriverOption } from "../providerDriverMeta";
import { ModelRow } from "./ModelRow";
import {
  CUSTOM_MODEL_PLACEHOLDER_BY_KIND,
  deriveProviderModelsForDisplay,
  modelMatchesSearchQuery,
  readConfigStringArray,
  type InstanceRow,
} from "./modelsPage.logic";

const COLLAPSED_ROW_LIMIT = 12;

/**
 * One provider instance's models, collapsed to a single header line until
 * opened. Rows sit in page flow instead of a nested scroller so the page has
 * one scrollbar, and the custom-model input only mounts when asked for.
 */
export function ProviderModelGroup(props: {
  readonly row: InstanceRow;
  readonly driverOption: DriverOption | undefined;
  readonly liveProvider: ServerProvider | undefined;
  readonly hiddenModels: ReadonlyArray<string>;
  readonly favoriteModels: ReadonlyArray<string>;
  readonly modelOrder: ReadonlyArray<string>;
  readonly searchQuery: string;
  readonly onHiddenModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onModelOrderChange: (next: ReadonlyArray<string>) => void;
  readonly onCustomModelsChange: (next: ReadonlyArray<string>) => void;
}) {
  const {
    row,
    driverOption,
    liveProvider,
    onCustomModelsChange,
    onFavoriteModelsChange,
    onHiddenModelsChange,
    onModelOrderChange,
  } = props;
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [addingCustom, setAddingCustom] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const driverKind = isProviderDriverKind(row.instance.driver) ? row.instance.driver : null;
  const displayName =
    row.instance.displayName?.trim() || driverOption?.label || String(row.instance.driver);
  const customModels = readConfigStringArray(row.instance.config, "customModels");
  const models = deriveProviderModelsForDisplay({ liveModels: liveProvider?.models, customModels });

  const hiddenModelSet = useMemo(() => new Set(props.hiddenModels), [props.hiddenModels]);
  const favoriteModelSet = useMemo(() => new Set(props.favoriteModels), [props.favoriteModels]);
  const orderedModels = sortModelsForProviderInstance(models, {
    favoriteModels: favoriteModelSet,
    groupFavorites: true,
    modelOrder: props.modelOrder,
  });
  const searching = props.searchQuery.trim().length > 0;
  const visibleModels = orderedModels.filter((model) =>
    modelMatchesSearchQuery(model, props.searchQuery),
  );

  const handleRemove = useCallback(
    (slug: string) => {
      onCustomModelsChange(customModels.filter((model) => model !== slug));
      onModelOrderChange(props.modelOrder.filter((model) => model !== slug));
      onFavoriteModelsChange(props.favoriteModels.filter((model) => model !== slug));
      setError(null);
    },
    [
      customModels,
      onCustomModelsChange,
      onFavoriteModelsChange,
      onModelOrderChange,
      props.favoriteModels,
      props.modelOrder,
    ],
  );

  const handleToggleHidden = useCallback(
    (slug: string) => {
      onHiddenModelsChange(
        hiddenModelSet.has(slug)
          ? props.hiddenModels.filter((model) => model !== slug)
          : [...props.hiddenModels, slug],
      );
    },
    [hiddenModelSet, onHiddenModelsChange, props.hiddenModels],
  );

  const handleToggleFavorite = useCallback(
    (slug: string) => {
      onFavoriteModelsChange(
        favoriteModelSet.has(slug)
          ? props.favoriteModels.filter((model) => model !== slug)
          : [...props.favoriteModels, slug],
      );
    },
    [favoriteModelSet, onFavoriteModelsChange, props.favoriteModels],
  );

  // Joined so the callback identity survives renders that re-derive an equal
  // order — otherwise every memoized row re-renders on each keystroke.
  const orderedSlugs = orderedModels.map((model) => model.slug).join("\n");
  const handleMove = useCallback(
    (slug: string, direction: -1 | 1) => {
      const slugs = orderedSlugs.split("\n");
      const index = slugs.indexOf(slug);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= slugs.length) return;
      const next = [...slugs];
      [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
      onModelOrderChange(next);
    },
    [onModelOrderChange, orderedSlugs],
  );

  const handleAdd = () => {
    const normalized = normalizeCustomModelSlug(input);
    if (!normalized) {
      setError("Enter a model slug.");
      return;
    }
    if (models.some((model) => !model.isCustom && model.slug === normalized)) {
      setError("That model is already built in.");
      return;
    }
    if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
      setError(`Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`);
      return;
    }
    if (customModels.includes(normalized)) {
      setError("That custom model is already saved.");
      return;
    }

    onCustomModelsChange([...customModels, normalized]);
    setInput("");
    setError(null);
    setOpen(true);
    setShowAll(true);
  };

  if (searching && visibleModels.length === 0) {
    return null;
  }

  const expanded = open || searching;
  const rows = showAll || searching ? visibleModels : visibleModels.slice(0, COLLAPSED_ROW_LIMIT);
  const FallbackIcon = driverOption?.icon;
  const favoriteCount = models.filter((model) => favoriteModelSet.has(model.slug)).length;
  const hiddenCount = models.filter((model) => hiddenModelSet.has(model.slug)).length;

  return (
    <div className="border-t border-border/60 first:border-t-0">
      <div className="flex items-center gap-1 px-2 py-1.5 sm:px-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-muted/40"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={expanded}
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
            aria-hidden
          />
          {driverKind ? (
            <ProviderInstanceIcon
              driverKind={driverKind}
              displayName={displayName}
              className="size-4"
              iconClassName="size-3.5 text-foreground/80"
            />
          ) : FallbackIcon ? (
            <FallbackIcon className="size-3.5 text-foreground/80" aria-hidden />
          ) : null}
          <span className="shrink-0 text-xs font-medium text-foreground">{displayName}</span>
          {String(row.instanceId) !== String(row.instance.driver) ? (
            <code className="shrink-0 rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground">
              {row.instanceId}
            </code>
          ) : null}
          <span className="truncate text-[11px] text-muted-foreground">
            {models.length === 0
              ? "no models"
              : `${models.length} model${models.length === 1 ? "" : "s"}`}
            {favoriteCount > 0 ? ` · ${favoriteCount} favorite` : ""}
            {hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ""}
          </span>
        </button>
        <Button
          size="xs"
          variant="ghost"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => {
            setAddingCustom((current) => !current);
            setOpen(true);
          }}
          title="Add a model slug this provider supports but does not advertise"
        >
          <PlusIcon className="size-3" />
          Custom
        </Button>
      </div>

      {addingCustom ? (
        <div className="px-3 pb-3 sm:px-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              autoFocus
              id={`provider-model-group-${row.instanceId}-custom-model`}
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setAddingCustom(false);
                  return;
                }
                if (event.key !== "Enter") return;
                event.preventDefault();
                handleAdd();
              }}
              placeholder={
                driverKind ? CUSTOM_MODEL_PLACEHOLDER_BY_KIND[driverKind] : "provider-model-slug"
              }
              spellCheck={false}
            />
            <Button className="shrink-0" variant="outline" onClick={handleAdd}>
              Add
            </Button>
          </div>
          {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
        </div>
      ) : null}

      {expanded ? (
        <div className="px-3 pb-2 sm:px-4">
          {models.length === 0 ? (
            <p className="px-1.5 py-1 text-[11px] text-muted-foreground">
              This provider reports no models. Add a custom slug, or connect it under Connections.
            </p>
          ) : null}

          {rows.map((model) => {
            const isFavorite = favoriteModelSet.has(model.slug);
            const fullIndex = orderedModels.findIndex((candidate) => candidate.slug === model.slug);
            const previousModel = orderedModels[fullIndex - 1];
            const nextModel = orderedModels[fullIndex + 1];

            return (
              <ModelRow
                key={`${row.instanceId}:${model.slug}`}
                model={model}
                isHidden={!model.isCustom && hiddenModelSet.has(model.slug)}
                isFavorite={isFavorite}
                canMoveUp={
                  previousModel !== undefined &&
                  favoriteModelSet.has(previousModel.slug) === isFavorite
                }
                canMoveDown={
                  nextModel !== undefined && favoriteModelSet.has(nextModel.slug) === isFavorite
                }
                onToggleHidden={handleToggleHidden}
                onToggleFavorite={handleToggleFavorite}
                onMove={handleMove}
                onRemoveCustom={handleRemove}
              />
            );
          })}

          {rows.length < visibleModels.length ? (
            <Button
              size="xs"
              variant="ghost"
              className="mt-1 text-muted-foreground hover:text-foreground"
              onClick={() => setShowAll(true)}
            >
              Show all {visibleModels.length}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
