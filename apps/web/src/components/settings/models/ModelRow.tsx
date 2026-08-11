"use client";

import { ArrowDownIcon, ArrowUpIcon, EyeIcon, EyeOffIcon, StarIcon, XIcon } from "lucide-react";
import { memo } from "react";
import type { ServerProviderModel } from "@t3tools/contracts";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { getModelCapabilityLabels } from "./modelsPage.logic";

/**
 * One model row: name, slug, and favorite/move/hide/remove-custom actions.
 *
 * Deliberately tooltip-free — a base-ui `Tooltip` per action meant five
 * floating-ui roots per row and hundreds per page, which is what made this
 * page crawl. Native `title` carries the same text for free.
 */
export const ModelRow = memo(function ModelRow(props: {
  readonly model: ServerProviderModel;
  readonly isHidden: boolean;
  readonly isFavorite: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly onToggleHidden: (slug: string) => void;
  readonly onToggleFavorite: (slug: string) => void;
  readonly onMove: (slug: string, direction: -1 | 1) => void;
  readonly onRemoveCustom: (slug: string) => void;
}) {
  const { model } = props;
  const capLabels = getModelCapabilityLabels(model);

  return (
    <div className="group flex min-h-8 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted/40">
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span
          className={cn(
            "shrink-0 truncate text-xs",
            props.isHidden ? "text-muted-foreground line-through" : "text-foreground/90",
          )}
          title={capLabels.length > 0 ? capLabels.join(" · ") : undefined}
        >
          {model.name}
        </span>
        {model.slug !== model.name ? (
          <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/70">
            {model.slug}
          </span>
        ) : null}
        {model.isCustom ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">custom</span>
        ) : null}
      </div>

      <div
        className={cn(
          "flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100",
          (props.isFavorite || props.isHidden) && "opacity-100",
        )}
      >
        <Button
          size="icon-xs"
          variant="ghost"
          className={cn(
            "size-6 rounded-sm p-0 text-muted-foreground hover:text-foreground",
            props.isFavorite && "text-yellow-500 hover:text-yellow-600",
          )}
          onClick={() => props.onToggleFavorite(model.slug)}
          title={props.isFavorite ? "Remove from favorites" : "Add to favorites"}
          aria-pressed={props.isFavorite}
          aria-label={`${props.isFavorite ? "Remove" : "Add"} ${model.name} ${
            props.isFavorite ? "from" : "to"
          } favorites`}
        >
          <StarIcon className={cn("size-3", props.isFavorite && "fill-current")} />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          className="size-6 rounded-sm p-0 text-muted-foreground hover:text-foreground"
          disabled={!props.canMoveUp}
          onClick={() => props.onMove(model.slug, -1)}
          title="Move up"
          aria-label={`Move ${model.name} up`}
        >
          <ArrowUpIcon className="size-3" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          className="size-6 rounded-sm p-0 text-muted-foreground hover:text-foreground"
          disabled={!props.canMoveDown}
          onClick={() => props.onMove(model.slug, 1)}
          title="Move down"
          aria-label={`Move ${model.name} down`}
        >
          <ArrowDownIcon className="size-3" />
        </Button>
        {model.isCustom ? (
          <Button
            size="icon-xs"
            variant="ghost"
            className="size-6 rounded-sm p-0 text-muted-foreground hover:text-destructive"
            onClick={() => props.onRemoveCustom(model.slug)}
            title="Remove custom model"
            aria-label={`Remove ${model.slug}`}
          >
            <XIcon className="size-3" />
          </Button>
        ) : (
          <Button
            size="icon-xs"
            variant="ghost"
            className="size-6 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            onClick={() => props.onToggleHidden(model.slug)}
            title={props.isHidden ? "Show in picker" : "Hide from picker"}
            aria-pressed={props.isHidden}
            aria-label={`${props.isHidden ? "Show" : "Hide"} ${model.name}`}
          >
            {props.isHidden ? <EyeIcon className="size-3" /> : <EyeOffIcon className="size-3" />}
          </Button>
        )}
      </div>
    </div>
  );
});
