import type {
  EnvironmentId,
  PromptAssistModelSelection,
  PromptAssistOperation,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback } from "react";

import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

export interface PromptAssistError {
  readonly message: string;
}

export type PromptAssistOptions = {
  readonly modelSelection?: PromptAssistModelSelection;
};

/**
 * Returns a callback that runs a model-driven prompt transform (improve, fix
 * spelling, or translate to a shell command) against the primary environment.
 * Resolves to the transformed text, or a `{ message }` error object.
 */
export function usePromptAssist(environmentId: EnvironmentId | null) {
  const run = useAtomCommand(serverEnvironment.promptAssist, { reportFailure: false });

  return useCallback(
    async (
      operation: PromptAssistOperation,
      text: string,
      options?: PromptAssistOptions,
    ): Promise<{ text: string } | PromptAssistError> => {
      if (environmentId === null) {
        return { message: "No environment connected." };
      }
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        return { message: "Nothing to transform." };
      }
      try {
        const result = await run({
          environmentId,
          input: {
            operation,
            text: trimmed,
            ...(options?.modelSelection ? { modelSelection: options.modelSelection } : {}),
          },
        });
        if (result._tag === "Failure") {
          const failure = squashAtomCommandFailure(result);
          return {
            message: failure instanceof Error ? failure.message : "Prompt assist failed.",
          };
        }
        return { text: result.value.text };
      } catch (error) {
        return { message: error instanceof Error ? error.message : "Prompt assist failed." };
      }
    },
    [environmentId, run],
  );
}
