/**
 * The live `BoardMoments` — the half of the moments that needs a `BoardApi`.
 *
 * `moments.ts` is the seam the store asks through; this is what answers. It is
 * built where a `BoardApi` exists, which is the same place the tick is built,
 * so a rule fires the same verbs whether a heartbeat or a drag caused it.
 *
 * @module kanban/components/live
 */
import type { BoardSettings, KanbanCard } from "@t3tools/contracts";
import { dispatch } from "@t3tools/shared/board";

import { recordDegradation } from "../../health/incidentLog.ts";
import type { BoardApi } from "../hermes/boardApi.ts";
import { boardCard, type PassRecorder } from "./card.ts";
import type { BoardMoments } from "./moments.ts";
import { componentFor } from "./seed.ts";

/**
 * How deep a chain of moves may run before it is a loop rather than a rule.
 *
 * An `enter` rule may move the card on, which is an `enter` somewhere else.
 * That is the redirect the board has always had — a drop on Prompts landing in
 * Active — and it is also how a pair of components that point at each other
 * would spin forever. Depth is what tells them apart.
 */
const MAX_CHAIN = 4;

export function makeBoardMoments(input: {
  readonly api: BoardApi;
  readonly settings: () => Promise<BoardSettings>;
  readonly policy: (settings: BoardSettings) => {
    readonly finishActive: boolean;
    readonly mergeWhenGreen: boolean;
    readonly conflictReturn: boolean;
  };
  /**
   * Where a rule's lines go, when a caller has somewhere to put them.
   *
   * The layer passes none: writing them needs a fiber, and running one from a
   * plain callback is escaping Effect mid-module, which this repo lints
   * against. Real failures still surface — `recordDegradation` below, and a
   * rule that throws is reported by `fireMoment`.
   */
  readonly log?: (line: string) => void;
  /** The clock, passed in: this module is outside Effect and owns no time. */
  readonly now: () => number;
}): BoardMoments {
  const run = async (
    cardId: string,
    at: string,
    moment: "enter" | "exit",
    depth: number,
  ): Promise<void> => {
    if (depth > MAX_CHAIN) {
      input.log?.(`moment ${moment}: ${cardId} — stopped after ${MAX_CHAIN} moves, rules loop`);
      return;
    }
    const settings = await input.settings();
    // A board that cannot be read is not an empty board: pretending it is would
    // run no rules and say nothing, which reads exactly like a component that
    // has none. Say so and leave the card alone.
    let cards: ReadonlyArray<KanbanCard>;
    try {
      cards = await input.api.list();
    } catch (cause) {
      recordDegradation({
        id: "board.moments",
        title: "A card moved and its rules could not run",
        detail:
          `card ${cardId} ${moment === "enter" ? "arrived at" : "left"} ${at}, but the board ` +
          `could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
      return;
    }
    const card = cards.find((entry) => (entry.id as string) === cardId);
    if (!card) return;

    let running = "";
    const recorder: PassRecorder = {
      logs: [],
      needsHuman: [],
      step: async (ruleId, detail, write) => {
        input.log?.(`rule ${ruleId}: ${cardId} — ${detail}`);
        try {
          await write();
          return null;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          input.log?.(`rule ${ruleId} failed on ${cardId}: ${message}`);
          return message;
        }
      },
    };

    const handle = boardCard({
      card,
      api: input.api,
      recorder,
      nowMs: input.now(),
      ruleId: () => running,
      // Nothing on an arrival merges: merging is gated on the forge's checks,
      // and those do not exist a second after a card lands.
      merge: async () => ({ merged: false, reason: null, conflict: null }),
    });

    await dispatch({
      card: handle,
      component: componentFor(at, { settings, policy: input.policy(settings) }),
      moment,
      onRun: (entry) => {
        running = entry.id ?? entry.name;
      },
    });
    for (const line of recorder.logs) input.log?.(line);
  };

  return {
    entered: ({ cardId, at }) => run(cardId, at, "enter", 0),
    left: ({ cardId, from }) => run(cardId, from, "exit", 0),
  };
}
