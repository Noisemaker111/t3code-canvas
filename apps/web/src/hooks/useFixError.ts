/**
 * Fix it — one click turns an error the app caught into work. The board keeps
 * the default (a Prompts card Hermes routes); Settings → Board → Fix it can
 * switch to a host thread for when the board itself is what broke.
 *
 * @module useFixError
 */
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useState } from "react";

import { useErrorLogStore, type ErrorLogEntry } from "../components/ui/errorLogStore";
import { toastManager } from "../components/ui/toast";
import { readBoardSettings } from "../lib/boardSettings";
import { fixItPrompt, fixItTitle } from "../lib/fixIt";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useKanbanCommands } from "../state/kanban";
import { useHostThreadLaunch } from "./useHostThreadLaunch";

export interface FixError {
  readonly fix: (errors: ReadonlyArray<ErrorLogEntry>) => void;
  readonly pending: boolean;
}

export function useFixError(): FixError {
  // Deliberately not the board query: a Fix it button renders per error toast
  // and per error-log row, and each one polling the board is not free.
  const { createCard } = useKanbanCommands(usePrimaryEnvironmentId());
  const { launch } = useHostThreadLaunch();
  const [pending, setPending] = useState(false);

  const fix = useCallback(
    (errors: ReadonlyArray<ErrorLogEntry>) => {
      if (pending || errors.length === 0) return;
      const board = readBoardSettings();
      const mode = board.errorFixMode;
      const title = fixItTitle(errors);
      const prompt = fixItPrompt(errors);
      setPending(true);
      void (async () => {
        try {
          if (mode === "thread") {
            await launch({ text: prompt, title });
          } else {
            const result = await createCard({ title, body: prompt, at: "prompts" });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            toastManager.add({
              type: "success",
              title: "Filed a fix card",
              description: board.hermesBrainEnabled
                ? "Hermes picks it up on its next tick."
                : "Hermes is off — the card waits in Prompts.",
            });
          }
          const { dismissEntry, entries, setModalOpen } = useErrorLogStore.getState();
          for (const error of errors) dismissEntry(error.id);
          if (entries.length === errors.length) setModalOpen(false);
        } catch (cause) {
          toastManager.add({
            type: "error",
            title: "Could not start the fix",
            description: cause instanceof Error ? cause.message : "Failed to file the fix.",
          });
        } finally {
          setPending(false);
        }
      })();
    },
    [createCard, launch, pending],
  );

  return { fix, pending };
}
