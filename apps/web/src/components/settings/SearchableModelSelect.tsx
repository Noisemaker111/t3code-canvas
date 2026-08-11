import { ChevronDownIcon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { formatRoutedModelLabel, modelMatchesSearch } from "../../lib/modelLabels";
import type { AppModelOption } from "../../modelSelection";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

/**
 * Board settings model picker: searchable list with openrouter/… prefixes.
 */
export function SearchableModelSelect(props: {
  readonly options: ReadonlyArray<AppModelOption>;
  readonly value: string;
  readonly onChange: (slug: string) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = useMemo(
    () => props.options.find((option) => option.slug === props.value) ?? null,
    [props.options, props.value],
  );

  const filtered = useMemo(
    () => props.options.filter((option) => modelMatchesSearch(option, query)),
    [props.options, query],
  );

  const triggerLabel = selected
    ? formatRoutedModelLabel(selected)
    : props.value
      ? props.value
      : (props.placeholder ?? "Select model");

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.disabled || props.options.length === 0}
            className={cn(
              "h-8 w-full min-w-[12rem] justify-between gap-2 px-2.5 font-normal",
              props.className,
            )}
          />
        }
      >
        <span className="min-w-0 truncate text-left text-xs">{triggerLabel}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        side="bottom"
        className="w-[min(100vw-2rem,20rem)] p-0"
        viewportClassName="p-0"
      >
        <div className="border-b border-border/70 p-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search openrouter/, zen/, model…"
              className="h-8 w-full rounded-md bg-raised py-1 pl-7 pr-2 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
            />
          </div>
        </div>
        <div className="max-h-56 overflow-y-auto overscroll-contain p-1">
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">No models</p>
          ) : (
            filtered.map((option) => {
              const label = formatRoutedModelLabel(option);
              const active = option.slug === props.value;
              return (
                <button
                  key={option.slug}
                  type="button"
                  className={cn(
                    "flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                    active && "bg-accent font-medium",
                  )}
                  onClick={() => {
                    props.onChange(option.slug);
                    setOpen(false);
                    setQuery("");
                  }}
                >
                  <span className="min-w-0 truncate font-mono text-[11px] leading-snug">
                    {label}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
