import { type ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { memo } from "react";
import { CheckIcon, StarIcon } from "lucide-react";
import {
  getDisplayModelName,
  getTriggerDisplayModelLabel,
  type ModelEsque,
  PROVIDER_ICON_BY_PROVIDER,
} from "./providerIconUtils";
import {
  costPerTaskDetail,
  formatCostPerTask,
  formatRouteThroughput,
  formatTimePerTask,
  type ModelRouteFacts,
} from "~/lib/modelRouteFacts";
import { ComboboxItem } from "../ui/combobox";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  model: ModelEsque;
  /** Instance the model belongs to — the routing key used in combobox values. */
  instanceId: ProviderInstanceId;
  /** Driver kind of the instance — used for the provider icon glyph. */
  driverKind: ProviderDriverKind;
  /**
   * Display name to show in the secondary line (provider footer). Usually
   * the instance's configured `displayName` so custom instances like
   * "Codex Personal" render with their user-authored label.
   */
  providerDisplayName: string;
  providerAccentColor?: string | undefined;
  isFavorite: boolean;
  isSelected: boolean;
  showProvider: boolean;
  preferShortName?: boolean;
  useTriggerLabel?: boolean;
  showNewBadge?: boolean;
  disabledReason?: string | null;
  /**
   * What this box measured on this exact route. Undefined means nothing has
   * measured it yet and the row stays silent — the alternative was a `$$$`
   * guessed from the model's name.
   */
  facts?: ModelRouteFacts | undefined;
  onToggleFavorite: () => void;
}) {
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[props.driverKind] ?? null;
  const providerLabel = props.model.subProvider
    ? `${props.providerDisplayName} · ${props.model.subProvider}`
    : props.providerDisplayName;

  const row = (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={`${props.instanceId}:${props.model.slug}`}
      disabled={Boolean(props.disabledReason)}
      contentClassName="flex w-full items-center gap-3"
      className={cn(
        "group relative w-full !min-w-0 max-w-full cursor-pointer rounded-md px-3 py-2.5 transition-[background-color,box-shadow,color]",
        "data-highlighted:bg-muted/56 data-selected:bg-transparent data-selected:text-foreground data-selected:ring-0",
        props.disabledReason &&
          "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed data-disabled:hover:bg-transparent",
      )}
    >
      <div className="min-w-0 flex-1 text-left">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 truncate text-xs font-medium leading-snug">
            {props.useTriggerLabel
              ? getTriggerDisplayModelLabel(props.model)
              : getDisplayModelName(
                  props.model,
                  props.preferShortName ? { preferShortName: true } : undefined,
                )}
          </div>
          {props.isSelected ? <CheckIcon className="size-3.5 shrink-0 text-blue-400" /> : null}
          {props.showNewBadge ? (
            <span
              className="shrink-0 rounded border border-amber-500/35 bg-amber-500/15 px-1 py-0.5 text-[10px] font-bold uppercase leading-none tracking-wide text-amber-800 dark:border-amber-400/30 dark:bg-amber-400/12 dark:text-amber-200"
              aria-label="New model"
            >
              New
            </span>
          ) : null}
        </div>
        {props.showProvider && (
          <div className="mt-1 flex items-center gap-1.5">
            {ProviderIcon ? <ProviderIcon className="size-3 shrink-0" /> : null}
            <span className="truncate text-xs font-normal leading-snug text-muted-foreground/70">
              {providerLabel}
            </span>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {props.facts ? (
          <span
            className="text-right font-mono text-[10px] leading-tight text-muted-foreground"
            // Both numbers or neither: tok/s alone reads as "this one is
            // quicker", which it does not say.
            title={`${formatRouteThroughput(props.facts)} · ${formatTimePerTask(props.facts)} · ${costPerTaskDetail(props.facts)}`}
          >
            <span className="block">{formatRouteThroughput(props.facts)}</span>
            <span className="block">
              {formatTimePerTask(props.facts)} · {formatCostPerTask(props.facts)}
            </span>
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                className={cn(
                  "-mr-1 shrink-0 text-muted-foreground/70 opacity-64 transition-[color,opacity] hover:text-foreground hover:opacity-100 group-hover:opacity-100",
                  props.isFavorite && "text-foreground opacity-100",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onToggleFavorite();
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                }}
                disabled={Boolean(props.disabledReason)}
                aria-label={props.isFavorite ? "Remove from favorites" : "Add to favorites"}
              >
                <StarIcon
                  className={cn(
                    "size-3.5 sm:size-3",
                    props.isFavorite && "fill-current text-yellow-500",
                  )}
                />
              </Button>
            }
          />
          <TooltipPopup side="top" align="center">
            {props.isFavorite ? "Remove from favorites" : "Add to favorites"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </ComboboxItem>
  );

  if (!props.disabledReason) {
    return row;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipPopup side="left" align="center" className="max-w-64 text-balance leading-snug">
        {props.disabledReason}
      </TooltipPopup>
    </Tooltip>
  );
});
