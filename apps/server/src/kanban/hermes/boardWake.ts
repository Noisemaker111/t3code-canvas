/**
 * Board writes that Hermes should act on now instead of on the next beat.
 *
 * The interval is for heartbeat work — reading reports, nudging, chasing a PR.
 * A card the user just sent or dropped is live: waiting up to a full interval
 * to structure it is the difference between a board that answers and one that
 * looks asleep. Only writes Hermes has a policy for wake it; a title tweak or a
 * delete does not buy a model call.
 *
 * Called from the request handlers (WS, MCP), never from `liveBoardApi` — a
 * tick's own writes must not schedule the next tick.
 *
 * @module kanban/hermes/boardWake
 */
import type { CanvasMessageTarget, ComponentId, KanbanPrepStatus } from "@t3tools/contracts";

import { requestHermesWake } from "./HermesBrain.ts";

export function wakeForCardCreated(input: { readonly at?: ComponentId | null }): void {
  requestHermesWake(`card created at ${input.at ?? "prompts"}`);
}

export function wakeForCardUpdated(input: {
  readonly at?: ComponentId | null;
  readonly body?: string | null;
  readonly prepStatus?: KanbanPrepStatus | null;
}): void {
  if (input.at !== undefined && input.at !== null) {
    requestHermesWake(`card moved to ${input.at}`);
    return;
  }
  if (input.body !== undefined || input.prepStatus !== undefined) {
    requestHermesWake("card edited");
  }
}

/**
 * A message addressed to Hermes. Waiting a whole interval to read your own
 * sentence is the difference between a chat and a suggestion box.
 */
export function wakeForCanvasMessage(input: { readonly target?: CanvasMessageTarget }): void {
  if (input.target !== "hermes") return;
  requestHermesWake("message to Hermes");
}
