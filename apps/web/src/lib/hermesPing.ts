/**
 * "What's up with this one?" — the bell, wherever it is drawn.
 *
 * A ping is a human message addressed to Hermes that names one card by id. That
 * is the one path the brain already answers: the message queues as a judgment
 * item so even a settled board runs the model, the card's id pulls its own
 * history into the prompt, and posting it wakes the loop to ~0.75s instead of
 * the next beat. The thread header and the card face share this hook, so both
 * bells send the same sentence and report the same outcome.
 *
 * @module lib/hermesPing
 */
import { useCallback, useState } from "react";

import { useCanvasCommands } from "../state/canvas";
import { usePrimaryEnvironment } from "../state/environments";
import { toastManager } from "../components/ui/toast";

export interface HermesPingTarget {
  readonly cardId: string;
  readonly title: string;
}

/**
 * The sentence the bell sends. The bare card id is load-bearing: Hermes
 * resolves a message to a card by id first, and that is what carries the card's
 * recorded ticks into the tick prompt.
 */
export function hermesPingMessage(target: HermesPingTarget): string {
  const title = target.title.trim();
  const named = title.length === 0 ? "" : ` ("${title}")`;
  return (
    `What's up with card ${target.cardId}${named}? ` +
    `Where does it stand, what is it waiting on, and what are you doing with it next?`
  );
}

export function useHermesPing() {
  const primaryEnvironment = usePrimaryEnvironment();
  const commands = useCanvasCommands(primaryEnvironment?.environmentId ?? null);
  const [pendingCardId, setPendingCardId] = useState<string | null>(null);

  const ping = useCallback(
    async (input: HermesPingTarget & { readonly hermesEnabled: boolean }) => {
      if (pendingCardId !== null) return;
      setPendingCardId(input.cardId);
      try {
        const result = await commands.postMessage({
          authorKind: "human",
          target: "hermes",
          text: hermesPingMessage(input),
        });
        if (result._tag === "Failure") {
          toastManager.add({
            type: "error",
            title: "Could not ping Hermes",
            description: "The message was not posted. Try again.",
          });
          return;
        }
        toastManager.add(
          input.hermesEnabled
            ? {
                type: "success",
                title: "Hermes pinged",
                description: "It answers in the Hermes panel, in about a second.",
              }
            : {
                type: "warning",
                title: "Hermes is off — your ping is waiting",
                description:
                  "Turn the brain on in Settings → Hermes and it answers on the next beat.",
              },
        );
      } catch {
        toastManager.add({
          type: "error",
          title: "Could not ping Hermes",
          description: "No environment is connected.",
        });
      } finally {
        setPendingCardId(null);
      }
    },
    [commands, pendingCardId],
  );

  return { ping, pendingCardId };
}
