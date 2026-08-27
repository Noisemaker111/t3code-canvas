import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";

import type { ComposerCommandItem } from "./ComposerCommandMenu";

type SlashCommandMenuItem = Extract<
  ComposerCommandItem,
  { type: "slash-command" | "global-skill-command" | "provider-slash-command" }
>;

function scoreSlashCommandItem(item: SlashCommandMenuItem, query: string): number | null {
  const primaryValue =
    item.type === "slash-command"
      ? item.command.toLowerCase()
      : item.type === "global-skill-command"
        ? item.skillCommandId.toLowerCase()
        : item.command.name.toLowerCase();
  const description = item.description.toLowerCase();

  const scores = [
    scoreQueryMatch({
      value: primaryValue,
      query,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: ["-", "_", "/"],
    }),
    scoreQueryMatch({
      value: description,
      query,
      exactBase: 20,
      prefixBase: 22,
      boundaryBase: 24,
      includesBase: 26,
    }),
  ].filter((score): score is number => score !== null);

  if (scores.length === 0) {
    return null;
  }

  return Math.min(...scores);
}

function tieBreakerForSlashCommandItem(item: SlashCommandMenuItem): string {
  if (item.type === "slash-command") {
    return `0:${item.command}`;
  }
  if (item.type === "global-skill-command") {
    return `1:${item.skillCommandId}`;
  }
  return `2:${item.command.name}:${item.provider}`;
}

export function searchSlashCommandItems(
  items: ReadonlyArray<SlashCommandMenuItem>,
  query: string,
): Array<SlashCommandMenuItem> {
  const normalizedQuery = normalizeSearchQuery(query, { trimLeadingPattern: /^\/+/ });
  if (!normalizedQuery) {
    return [...items];
  }

  const ranked: Array<{
    item: SlashCommandMenuItem;
    score: number;
    tieBreaker: string;
  }> = [];

  for (const item of items) {
    const score = scoreSlashCommandItem(item, normalizedQuery);
    if (score === null) {
      continue;
    }

    insertRankedSearchResult(
      ranked,
      {
        item,
        score,
        tieBreaker: tieBreakerForSlashCommandItem(item),
      },
      Number.POSITIVE_INFINITY,
    );
  }

  return ranked.map((entry) => entry.item);
}
