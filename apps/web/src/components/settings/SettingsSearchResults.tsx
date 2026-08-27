"use client";

import { SearchIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import {
  highlightQuerySegments,
  searchSettingsCatalog,
  type SettingsSearchMatch,
} from "./settingsSearchCatalog";
import { SettingsPageContainer } from "./settingsLayout";

function HighlightedText({
  text,
  query,
  className,
}: {
  text: string;
  query: string;
  className?: string;
}) {
  const segments = highlightQuerySegments(text, query);
  return (
    <span className={className}>
      {segments.map((segment, index) =>
        segment.match ? (
          <mark
            key={`${index}-${segment.text}`}
            className="rounded-sm bg-yellow-300/80 px-0.5 text-foreground dark:bg-yellow-400/50 dark:text-foreground"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={`${index}-${segment.text}`}>{segment.text}</span>
        ),
      )}
    </span>
  );
}

export function SettingsSearchResults({
  query,
  onSelect,
  onNavigate,
}: {
  query: string;
  onSelect: () => void;
  /** Open the section a match lives in — the canvas settings panel's switch. */
  onNavigate: (match: SettingsSearchMatch) => void;
}) {
  const matches = searchSettingsCatalog(query);

  return (
    <SettingsPageContainer>
      <div className="space-y-3">
        <div className="flex items-center gap-2 px-1">
          <SearchIcon className="size-3.5 text-muted-foreground" />
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
            Search results
            {query.trim() ? (
              <span className="ml-2 font-normal normal-case tracking-normal text-muted-foreground">
                for “{query.trim()}”
              </span>
            ) : null}
          </h2>
        </div>

        {matches.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border/70 bg-card/40 px-4 py-10 text-center text-sm text-muted-foreground">
            No settings match “{query.trim()}”.
          </div>
        ) : (
          <ul className="overflow-hidden rounded-2xl border bg-card shadow-sm/4">
            {matches.map((match) => (
              <SearchResultRow
                key={match.id}
                match={match}
                query={query}
                onSelect={() => {
                  onSelect();
                  onNavigate(match);
                  window.setTimeout(() => {
                    const target = document.getElementById(match.id);
                    target?.scrollIntoView({ behavior: "smooth", block: "center" });
                    target?.animate(
                      [
                        { outlineColor: "transparent" },
                        { outlineColor: "var(--ring)" },
                        { outlineColor: "transparent" },
                      ],
                      { duration: 1_400, easing: "ease-out" },
                    );
                  }, 100);
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </SettingsPageContainer>
  );
}

function SearchResultRow({
  match,
  query,
  onSelect,
}: {
  match: SettingsSearchMatch;
  query: string;
  onSelect: () => void;
}) {
  return (
    <li className="border-t border-border/60 first:border-t-0">
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "flex w-full flex-col gap-1 px-4 py-3.5 text-left transition-colors sm:px-5",
          "hover:bg-accent/40",
        )}
      >
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
          <HighlightedText text={match.section} query={query} />
        </span>
        <span className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">
          <HighlightedText text={match.title} query={query} />
        </span>
        <span className="text-xs leading-relaxed text-muted-foreground">
          <HighlightedText text={match.description} query={query} />
        </span>
      </button>
    </li>
  );
}
