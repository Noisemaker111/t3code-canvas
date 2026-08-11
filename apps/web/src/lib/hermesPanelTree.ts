/**
 * Groups the flat Hermes feed into a project → card → action tree for the
 * panel. A row nests under a card when its own text names that card — by id,
 * by the 8-char prefix the summaries abbreviate to, or by the card's title —
 * so no extra plumbing from the tick recorder is required. A row that names no
 * live card (a reply, a rules sweep touching an archived card) stands alone
 * instead of forcing a false grouping.
 */
import type { KanbanCard, ProjectId } from "@t3tools/contracts";

import type { HermesFeedRow } from "./hermesChatFeed";

export type PanelTreeItem =
  | { readonly type: "you" | "thread"; readonly row: HermesFeedRow }
  | {
      readonly type: "standalone";
      readonly row: HermesFeedRow;
      /** How many identical lines in a row this one stands for. The rules pass
       * writes the same heartbeat line every tick; twenty copies of it push the
       * work off the panel. */
      readonly repeat: number;
    }
  | { readonly type: "project"; readonly title: string; readonly colorClass: string }
  | { readonly type: "card"; readonly title: string; readonly prNumber: number | null }
  | {
      readonly type: "action";
      readonly row: HermesFeedRow;
      /** The row's own line with the card id it opens with taken off — the card
       * header above it already says which card this is. */
      readonly summary: string;
    };

/** A card Hermes could not route still has work under it; it just has no project
 * to file that work under. Naming the gap keeps those lines in the tree. */
export const UNROUTED_PROJECT_TITLE = "unrouted";

/** Cycles per project, following the ad-hoc tone-class precedent already used
 * for the Hermes settings chip (`HermesSettingsPanel.tsx`'s `CHIP_TONE_CLASS`). */
const PROJECT_COLOR_CYCLE: ReadonlyArray<string> = [
  "text-sky-700 dark:text-sky-300",
  "text-rose-700 dark:text-rose-300",
  "text-amber-700 dark:text-amber-300",
  "text-violet-700 dark:text-violet-300",
  "text-emerald-700 dark:text-emerald-300",
  "text-orange-700 dark:text-orange-300",
];

/** Long enough that a shared word can't collide two cards. */
const MIN_TITLE_MATCH = 6;

function findCardForRow(row: HermesFeedRow, cards: ReadonlyArray<KanbanCard>): KanbanCard | null {
  const haystack = `${row.summary} ${row.text}`;
  const lower = haystack.toLowerCase();
  for (const card of cards) {
    if (haystack.includes(card.id)) return card;
  }
  for (const card of cards) {
    const short = card.id.slice(0, 8);
    if (short.length === 8 && haystack.includes(short)) return card;
  }
  for (const card of cards) {
    if (card.title.length >= MIN_TITLE_MATCH && lower.includes(card.title.toLowerCase())) {
      return card;
    }
  }
  return null;
}

/** "e6b09259-…-57a414919143: could not route Settings history purge" → the
 * sentence. The id is the card header's job, and it eats the readable half of
 * a narrow panel. */
function stripLeadingCardId(summary: string, cardId: string): string {
  const short = cardId.slice(0, 8);
  const match = /^\s*(?<id>[0-9a-f-]{8,}|card-[0-9a-z]+)\s*(?:[:—-]\s*|\s)/i.exec(summary);
  const id = match?.groups?.id;
  if (id === undefined) return summary;
  if (id !== cardId && !cardId.startsWith(id) && !id.startsWith(short)) return summary;
  return summary.slice(match![0].length);
}

/** Consecutive copies of the same cardless line become one row with a count. */
function pushStandalone(items: PanelTreeItem[], row: HermesFeedRow): void {
  const last = items[items.length - 1];
  if (last?.type === "standalone" && last.row.summary === row.summary) {
    items[items.length - 1] = { ...last, repeat: last.repeat + 1 };
    return;
  }
  items.push({ type: "standalone", row, repeat: 1 });
}

export function buildPanelTree(
  rows: ReadonlyArray<HermesFeedRow>,
  cards: ReadonlyArray<KanbanCard>,
  projectTitleById: ReadonlyMap<ProjectId, string>,
): ReadonlyArray<PanelTreeItem> {
  const items: PanelTreeItem[] = [];
  const projectColor = new Map<string, string>();
  let lastProjectTitle: string | null = null;
  let lastCardTitle: string | null = null;

  const colorFor = (title: string): string => {
    if (title === UNROUTED_PROJECT_TITLE) return "text-muted-foreground";
    const existing = projectColor.get(title);
    if (existing !== undefined) return existing;
    const next = PROJECT_COLOR_CYCLE[projectColor.size % PROJECT_COLOR_CYCLE.length]!;
    projectColor.set(title, next);
    return next;
  };

  for (const row of rows) {
    if (row.speaker === "you" || row.speaker === "thread") {
      items.push({ type: row.speaker, row });
      lastCardTitle = null;
      continue;
    }
    if (row.speaker === "board") continue; // the raw delta preamble — not for humans

    const card = findCardForRow(row, cards);

    if (card === null) {
      pushStandalone(items, row);
      lastCardTitle = null;
      continue;
    }

    const projectTitle =
      (card.projectId ? projectTitleById.get(card.projectId) : undefined) ?? UNROUTED_PROJECT_TITLE;

    if (projectTitle !== lastProjectTitle) {
      items.push({ type: "project", title: projectTitle, colorClass: colorFor(projectTitle) });
      lastProjectTitle = projectTitle;
      lastCardTitle = null;
    }
    if (card.title !== lastCardTitle) {
      items.push({ type: "card", title: card.title, prNumber: card.prNumber });
      lastCardTitle = card.title;
    }
    items.push({ type: "action", row, summary: stripLeadingCardId(row.summary, card.id) });
  }

  return items;
}
