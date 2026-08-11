/**
 * The one gate every column move passes.
 *
 * This used to live in `BoardControl` and was called from two of the four
 * writers — Board Control and `launch_active`. `KanbanStore.update` did not
 * call it, so every Hermes move (`rulePass`, the whole `api.updateCard`
 * surface) went around it. The gate is here, and the store calls it, so there
 * is one answer to "may this card land there" rather than one per caller.
 *
 * The checks are card shape, not lane order. "Active only accepts cards from
 * Prompts" was the old rule and it was wrong in both directions: it refused the
 * recovery moves the tick makes every day (`pr-checks-red` and `pr-conflicts`
 * send a card from PR back to Active) while allowing anything that happened to
 * be standing in the right lane. What Active actually needs is work it can do —
 * a thread already behind the card, or a prompt somebody routed.
 *
 * @module kanban/moveGate
 */
import type { KanbanCard, ComponentId } from "@t3tools/contracts";

import { hasPr, hasThread, isRouted } from "./cardFacts.ts";

export interface BoardConventions {
  /** Active needs a thread behind the card, or a routed prompt. */
  readonly requireWorkForActive: boolean;
  /** PR needs a thread to push, or a pull request to adopt. */
  readonly requireWorkForPr: boolean;
  /** Off by default; no review pass gates the PR column today. */
  readonly requireReviewBeforePr: boolean;
}

export const DEFAULT_BOARD_CONVENTIONS: BoardConventions = {
  requireWorkForActive: true,
  requireWorkForPr: true,
  requireReviewBeforePr: false,
};

/**
 * Why this card may not land on `target`, or null when it may.
 *
 * Callers gate on an actual change of column: asking whether a card may move
 * where it already is is not a question, and `update` merges a column into
 * every partial write.
 */
export function explainMoveBlock(
  card: KanbanCard,
  target: ComponentId,
  conventions: BoardConventions = DEFAULT_BOARD_CONVENTIONS,
): string | null {
  if (card.at === target) return "Card is already in that column.";

  if (target === "active" && conventions.requireWorkForActive) {
    // A card coming back from PR carries the thread that wrote the code, and
    // that is the whole point of sending it back — it is not a fresh launch.
    if (!hasThread(card) && !isRouted(card)) {
      return "Active needs a project. Pick one on the card, or let Hermes route it.";
    }
  }

  if (target === "pr" && conventions.requireWorkForPr) {
    // A pull request with no thread is one dragged off a review panel: there is
    // nothing to push, and the PR column adopts it.
    if (!hasThread(card) && !hasPr(card)) {
      return "PR needs a coding thread to push, or an existing pull request.";
    }
  }

  if (target === "pr" && conventions.requireReviewBeforePr) {
    return "PR requires a completed review (convention enabled).";
  }

  return null;
}
