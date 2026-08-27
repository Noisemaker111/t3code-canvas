/**
 * The board's four primitives.
 *
 * A column, a terminal, a PR review panel and a status view are one thing with
 * different fields filled in. What a thing *does* is a list of rules; what it
 * *looks like* is a card face and a chrome level; where it sits is the canvas's
 * business and appears nowhere here.
 *
 * The invariant the whole design exists for:
 *
 * > If it runs, it is in the component's `rules` list. If it is not in the
 * > list, it does not run.
 *
 * That is why `rules` is an array of standalone values rather than an object of
 * privileged keys. A rule can be exported, tested without an engine, shared
 * between components, and rendered in a list — and there is nowhere to hide a
 * behavior the list does not mention. `COLUMN_BUILTIN_BEHAVIORS` in
 * `boardRules.ts` is the hand-maintained English apology for that not being
 * true today, and it cannot survive this.
 *
 * No React and no server imports: the view slots are a type parameter, so the
 * web fills them with `ReactNode` and the tick does not have to care.
 *
 * @module board/component
 */
import type { CardFacts } from "../cardFacts.ts";

/** The only three times anything runs. */
export type Moment = "enter" | "exit" | "tick";

/**
 * A card, and what can be done to it.
 *
 * Data and verbs on one object because there is one thing there. The verbs are
 * supplied by whoever runs the engine — the tick against the store, the browser
 * against the socket — so nothing here knows how a move is persisted.
 */
export interface CardHandle extends CardFacts {
  readonly id: string;
  /** The component holding it. A component never hardcodes its own id. */
  readonly at: string;
  readonly title: string;
  readonly body: string;

  /** `detail` is the line the tick log shows; the rule's own id names it. */
  moveTo(to: string, detail?: string): Promise<void>;
  /**
   * Hand the card back to the thread that owns it with something to do.
   *
   * Move, nudge, count the round, and file it as a human's once the rule's
   * `giveUpAfter` is spent — one concept, and the third copy of it in the tick
   * is what earned it a name.
   */
  sendBack(to: string, message: string, detail?: string): Promise<void>;
  /** Nothing more a rule can do. Says why, in words a person can act on. */
  needsHuman(reason: string): Promise<void>;

  startThread(): Promise<void>;
  nudge(message: string): Promise<void>;
  /** The refusal, or null when it landed. A refused push is not an exception. */
  openPr(): Promise<string | null>;
  mergePr(): Promise<string | null>;
  releaseWorktree(): Promise<void>;
  restoreWorktree(): Promise<void>;
}

/**
 * A named type guard.
 *
 * `name` reads as the tail of a refusal — "PR " + "needs a thread behind it" —
 * so one value serves both the gate that rejects and the rule that narrows,
 * and a refusal never has to be written twice.
 */
export interface Check<C extends CardHandle = CardHandle, In extends CardHandle = CardHandle> {
  readonly name: string;
  test(card: In): card is C & In;
}

export function check<C extends CardHandle, In extends CardHandle = CardHandle>(
  name: string,
  test: (card: In) => card is C & In,
): Check<C, In> {
  return { name, test };
}

/**
 * A moment, and optionally a condition on it.
 *
 * A trigger with no `detect` fires whenever its moment happens. One that has
 * `detect` fires when it returns anything but null, and what it returns is the
 * payload the rule's `do` receives — so `checksRed` hands over the checks and
 * nothing has to be annotated at the call site.
 *
 * Triggers are values, so extending the vocabulary is exporting one rather than
 * editing a union in an engine.
 */
export interface Trigger<P = void, C extends CardHandle = CardHandle> {
  readonly name: string;
  readonly on: Moment;
  readonly detect?: (card: C) => Promise<P | null> | P | null;
}

export function trigger<P = void, C extends CardHandle = CardHandle>(
  spec: Trigger<P, C>,
): Trigger<P, C> {
  return spec;
}

/**
 * One thing a component does.
 *
 * `do`, never `then`: an object with a `then` method is a thenable, and `await`
 * would try to unwrap the rule itself.
 *
 * `giveUpAfter` is the engine's, not the handler's. Every bounce in the tick
 * today writes the same `round > limit` check by hand; declaring the number
 * deletes the copy and leaves the rule saying only what it does.
 */
export interface Rule<P = void, C extends CardHandle = CardHandle, N extends C = C> {
  /** The sentence the rules list shows. Required on purpose. */
  readonly name: string;
  /**
   * The stable key its fire counter records under, when it has one.
   *
   * `name` is prose and may be reworded; this is what the tick log and
   * `HermesRuleStat` key on, so a rule can be renamed without losing its
   * history. Omit it and the rule has no counter of its own.
   */
  readonly id?: string;
  readonly when: Trigger<P, C>;
  /** Narrows the card `do` receives. Skipped when it does not hold. */
  readonly if?: Check<N, C>;
  /** Skipped when this holds. The declarative form of a defensive early return. */
  readonly unless?: Check<CardHandle, C>;
  /** Fires this many times on one card, then the card is a human's. */
  readonly giveUpAfter?: number;
  /**
   * The saved settings row that switches this rule, when one governs it.
   *
   * A board that has edited its columns stores rows in
   * `boardSettings.rules`, and deleting a row is how a person turns a
   * behavior off. A ported rule that ignored them would switch every such
   * board's policy back on at the first tick.
   */
  readonly row?: {
    readonly trigger: string;
    readonly action: string;
    readonly arg?: string;
  };
  /** The return is ignored; `unknown` so a one-expression `do` needs no wrapper. */
  readonly do: (card: N, payload: P) => unknown;
}

export function rule<P = void, C extends CardHandle = CardHandle, N extends C = C>(
  spec: Rule<P, C, N>,
): Rule<P, C, N> {
  return spec;
}

/**
 * A rule of any payload, as a list holds it.
 *
 * `Rule<never, never>` cannot stand in: a trigger's payload appears in the
 * return position of `detect`, so narrowing it to `never` refuses every real
 * trigger and every component would need a cast at its own `rules` array.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an existential; see above
export type AnyRule<C extends CardHandle = CardHandle> = Rule<any, C, any>;

/**
 * A panel: what it does and how it looks.
 *
 * No `id`. The id is the panel's address on the canvas, so two panels can run
 * one definition and a component never names itself.
 *
 * `accepts` means cards are stored here — droppable, and the move gate asks it.
 * `contains` means they are matched — a derived view, read-only, no drop
 * target. A card lives in exactly one place and shows in as many views as match
 * it, which is how a status board and a kanban are the same cards open at once.
 *
 * A component that holds nothing fills in neither, and is a terminal.
 */
export interface Component<V = never, C extends CardHandle = CardHandle> {
  readonly title: string;
  readonly accepts?: Check<CardHandle, CardHandle>;
  readonly contains?: (card: CardHandle) => boolean;
  /** Ordered. First match wins per moment. */
  readonly rules?: ReadonlyArray<AnyRule<C>>;
  /** One card's face. The default `render` stacks these. */
  readonly card?: (card: CardHandle) => V;
  /** The whole panel, when a stack of cards is not what this is. */
  readonly render?: (cards: ReadonlyArray<CardHandle>) => V;
  readonly chrome?: Chrome;
}

/** How much furniture a panel draws around itself. */
export type Chrome =
  /** Frame, header bar, gear, expand. */
  | "panel"
  /** Dot, title, count. No frame. */
  | "bare"
  /** A hairline border on the canvas's own background. */
  | "hairline";

export function component<V = never, C extends CardHandle = CardHandle>(
  spec: Component<V, C>,
): Component<V, C> {
  return spec;
}
