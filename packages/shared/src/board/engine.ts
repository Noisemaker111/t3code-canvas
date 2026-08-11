/**
 * The engine — every rule the board runs, and the gate every move passes.
 *
 * Forty lines, and that is the point: once behavior is a list of rules, running
 * them is a loop. The complexity that used to live in `rulePass.ts` was never
 * dispatch, it was thirteen behaviors written in five mechanisms.
 *
 * @module board/engine
 */
import type { AnyRule, CardHandle, Component, Moment } from "./component.ts";

/**
 * How many times a rule has already fired on this card, and the write that
 * records one more. Supplied by the caller because it has to outlive a tick —
 * the tick already keeps these counters, and a rule that forgets its rounds
 * asks the same question forever.
 */
export interface RoundLedger {
  roundsSoFar(cardId: string, ruleName: string): number | Promise<number>;
  countRound(cardId: string, ruleName: string): void | Promise<void>;
}

/** A ledger that forgets. Rules with no `giveUpAfter` never consult one. */
export const NO_ROUNDS: RoundLedger = {
  roundsSoFar: () => 0,
  countRound: () => {},
};

export interface DispatchResult {
  /** The rule that ran, or null when nothing matched. */
  readonly fired: string | null;
  /** True when the rule was skipped because its round budget was spent. */
  readonly gaveUp: boolean;
}

/**
 * Run the first rule of `component` that matches this card at this moment.
 *
 * One rule per card per moment. `rules` is an array, not a set: order is the
 * component's, and first match wins — the same shape the rule pass has today
 * with its `continue` after each action, and the reason a card cannot be moved
 * twice in one tick.
 */
export async function dispatch<C extends CardHandle>(input: {
  readonly card: C;
  readonly component: Component<unknown, C>;
  readonly moment: Moment;
  readonly rounds?: RoundLedger;
  /** Answers whether a rule's saved settings row still switches it on. */
  readonly enabled?: (rule: AnyRule<C>) => boolean;
  /** Called with the rule about to run, before its `do`. */
  readonly onRun?: (rule: AnyRule<C>) => void;
}): Promise<DispatchResult> {
  const { card, component, moment } = input;
  const rounds = input.rounds ?? NO_ROUNDS;

  for (const step of component.rules ?? []) {
    if (step.when.on !== moment) continue;
    // A board that has edited its columns keeps rows in settings, and deleting
    // one is how a person turns a behavior off. A rule with no row is this
    // build's code and cannot be switched off from there.
    if (step.row && input.enabled && !input.enabled(step)) continue;
    if (step.if && !step.if.test(card)) continue;
    if (step.unless && step.unless.test(card)) continue;

    const payload = step.when.detect ? await step.when.detect(card) : undefined;
    // Null is "did not fire". Undefined is a trigger with no payload, which is
    // every lifecycle trigger, so it must not read as a miss.
    if (payload === null) continue;

    if (step.giveUpAfter !== undefined) {
      const so_far = await rounds.roundsSoFar(card.id, step.name);
      if (so_far >= step.giveUpAfter) {
        input.onRun?.(step);
        await card.needsHuman(`${step.name} — gave up after ${step.giveUpAfter}`);
        return { fired: step.name, gaveUp: true };
      }
      await rounds.countRound(card.id, step.name);
    }

    input.onRun?.(step);
    await step.do(card, payload);
    return { fired: step.name, gaveUp: false };
  }

  return { fired: null, gaveUp: false };
}

/**
 * Why this card may not land on `target`, or null when it may.
 *
 * The refusal reads as the component's title plus its check's name, so a check
 * carries its rejection wording once instead of every gate spelling one out.
 *
 * A component with no `accepts` takes anything: holding cards is the default
 * for a place, and a column somebody added is a place to put things until they
 * give it rules.
 */
export function refuseMove(input: {
  readonly card: CardHandle;
  /** Only the two fields a gate reads, so any component satisfies it. */
  readonly target: Pick<Component<unknown, never>, "title" | "accepts">;
  readonly targetId: string;
}): string | null {
  const { card, target, targetId } = input;
  if (card.at === targetId) return "Card is already in that column.";
  if (!target.accepts || target.accepts.test(card)) return null;
  return `${target.title} ${target.accepts.name}.`;
}
