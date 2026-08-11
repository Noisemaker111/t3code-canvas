import type {
  CanvasAckInjectionsInput,
  CanvasDocument,
  CanvasInjection,
  CanvasMessage,
  CanvasPostMessageInput,
  CanvasSaveInput,
  EnvironmentId,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { usePrimaryEnvironment } from "./environments";
import { useEnvironmentQuery, useStickyEnvironmentData } from "./query";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

const EMPTY_INJECTIONS: ReadonlyArray<CanvasInjection> = [];
const EMPTY_MESSAGES: ReadonlyArray<CanvasMessage> = [];

/** The persisted tldraw document for the primary environment's board canvas. */
export function useCanvasDocument() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.canvasDocument({ environmentId, input: {} }),
  );
  const stable = useStickyEnvironmentData(environmentId, data);

  return {
    environmentId,
    document: (stable?.document ?? null) as CanvasDocument | null,
    error,
    isPending,
    refresh,
  };
}

/** Drawings Hermes queued that this browser has not materialized yet. */
export function useCanvasInjections() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const { data, error, refresh } = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.canvasInjections({ environmentId, input: {} }),
  );

  return {
    injections: data?.injections ?? EMPTY_INJECTIONS,
    error,
    refresh,
  };
}

/** The canvas conversation: everything humans, threads and Hermes addressed. */
export function useCanvasMessages() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const { data, error, refresh } = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.canvasMessages({
          environmentId,
          input: { undeliveredOnly: false, limit: 60 },
        }),
  );
  const stable = useStickyEnvironmentData(environmentId, data);

  return { messages: stable?.messages ?? EMPTY_MESSAGES, error, refresh };
}

export function useCanvasCommands(environmentId: EnvironmentId | null) {
  const save = useAtomCommand(serverEnvironment.canvasSave, { reportFailure: false });
  const ack = useAtomCommand(serverEnvironment.canvasAckInjections, { reportFailure: false });
  const postMessage = useAtomCommand(serverEnvironment.canvasPostMessage, { reportFailure: false });

  const noEnvironment = () => Promise.reject(new Error("No environment connected."));

  return useMemo(
    () => ({
      saveSnapshot: (input: CanvasSaveInput) =>
        environmentId === null ? noEnvironment() : save({ environmentId, input }),
      ackInjections: (input: CanvasAckInjectionsInput) =>
        environmentId === null ? noEnvironment() : ack({ environmentId, input }),
      postMessage: (input: CanvasPostMessageInput) =>
        environmentId === null ? noEnvironment() : postMessage({ environmentId, input }),
    }),
    [environmentId, save, ack, postMessage],
  );
}
