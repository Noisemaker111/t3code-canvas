/**
 * What a card *is*, asked of the card.
 *
 * A card accumulates: it starts as a prompt somebody wrote, gains a thread when
 * an agent picks it up, gains a pull request when the work is pushed. Nothing
 * replaces anything — a card in PR is still the prompt it started as.
 *
 * The board used to ask these questions by column id. "Is this card openable as
 * a thread" was spelled `column === "active" || column === "pr" || column ===
 * "done"`, and "does this card have CI worth polling" was a set of two lane
 * names. Both are facts about the card, and asking a lane for them is wrong in
 * two directions: a card in a column somebody added is invisible to them, and a
 * card standing in the right lane answers yes whether or not it has the thing.
 *
 * These are the questions. Which columns exist is not one of them.
 *
 * @module cardFacts
 */

/** The slice every fact here reads. Wider card types satisfy it structurally. */
export interface CardFacts {
  readonly threadId?: string | null;
  readonly prUrl?: string | null;
  readonly prepStatus?: string | null;
  readonly projectId?: string | null;
}

/** An agent has picked this card up. */
export function hasThread(card: CardFacts): boolean {
  return typeof card.threadId === "string" && card.threadId.length > 0;
}

/** The work is on the forge. True in Active too, for a card sent back to fix CI. */
export function hasPr(card: CardFacts): boolean {
  return typeof card.prUrl === "string" && card.prUrl.length > 0;
}

/**
 * The card knows where to run. Hermes says so with `prepStatus`; a human says
 * so by picking the project.
 *
 * `processing` counts: the structuring pass writes it before it finishes, and a
 * card the board refuses to launch because its own pass has not returned yet is
 * a deadlock, not a gate.
 *
 * The human half is the whole point of the pickers on the card. Reading only
 * `prepStatus` meant a card with a project and a model chosen by hand was
 * refused at Active — and editing that card writes `prepStatus: untouched`, so
 * setting the route was what made the card unlaunchable.
 */
export function isRouted(card: CardFacts): boolean {
  if (card.prepStatus === "ready" || card.prepStatus === "processing") return true;
  return hasProject(card);
}

/** A project is picked, so Active has a checkout to cut a worktree from. */
export function hasProject(card: CardFacts): boolean {
  return typeof card.projectId === "string" && card.projectId.length > 0;
}

/** Nobody has started work. The card is still only what somebody typed. */
export function isUnstarted(card: CardFacts): boolean {
  return !hasThread(card) && !hasPr(card);
}

/** Which layer a card wears — the newest thing it has grown. */
export type CardLayer = "pr" | "thread" | "prompt";

/**
 * The layer a card's face should read from. Each one brings its own content: the
 * prompt is what you wrote, the thread is what the agent is doing, the pull
 * request is what shipped. The newest one that exists wins.
 */
export function latestLayer(card: CardFacts): CardLayer {
  if (hasPr(card)) return "pr";
  if (hasThread(card)) return "thread";
  return "prompt";
}
