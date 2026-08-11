/**
 * Status views — components that *match* cards instead of holding them.
 *
 * A component with `accepts` is a place: cards are stored there, it is a drop
 * target, and moving one is a write. A component with `contains` is a view: it
 * asks a question of every card and shows the ones that answer yes. Nothing is
 * stored, nothing moves, and the same card shows in as many views as match it.
 *
 * That difference is the whole status board. Backlog / Running / Waiting are
 * not four more lanes to drag between — they are three questions about the
 * cards the board already has, so a status frame and a kanban frame are the
 * same cards read two ways, open at once.
 *
 * @module board/views
 */
import { hasPr, hasThread, isUnstarted, type CardFacts } from "../cardFacts.ts";
import { component, type Component } from "./component.ts";

/**
 * Nobody has picked it up. The card is still only what somebody typed.
 *
 * Deliberately not "sits in the intake component": a prompt somebody dragged
 * somewhere else has still not been started, and a view that missed it would be
 * lying about the board.
 */
export const backlog: Component<never> = component({
  title: "Backlog",
  contains: (card) => isUnstarted(card),
  chrome: "bare",
});

/** An agent has it and there is nothing on the forge yet. */
export const running: Component<never> = component({
  title: "Running",
  contains: (card) => hasThread(card) && !hasPr(card),
  chrome: "bare",
});

/** The work is up for review. */
export const inReview: Component<never> = component({
  title: "In review",
  contains: (card) => hasPr(card),
  chrome: "bare",
});

/** The status board, as the three questions it asks. */
export const STATUS_VIEWS: ReadonlyArray<Component<never>> = [backlog, running, inReview];

/**
 * The cards a view shows, in the order it was given them.
 *
 * A component with no `contains` is a place, not a view, and shows nothing
 * here — asking a place to match cards is a category error, and answering
 * "all of them" would quietly put every card in every panel.
 */
export function viewCards<C extends CardFacts & { readonly at: string }>(
  view: Component<never>,
  cards: ReadonlyArray<C>,
): ReadonlyArray<C> {
  const matches = view.contains;
  if (matches === undefined) return [];
  return cards.filter((card) => matches(card as never));
}
