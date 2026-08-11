/**
 * btw runtime commands — thin wrappers over the btw RPCs that drive the
 * {@link useBtwPanelStore}. Streaming replies are applied chunk-by-chunk so the
 * assistant bubble grows token-by-token. All calls run against the thread's
 * environment; nothing here touches the main coding thread.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { request, runStream } from "@t3tools/client-runtime/rpc";
import {
  createRuntimeCommand,
  runInEnvironment,
  runStreamInEnvironment,
} from "@t3tools/client-runtime/state/runtime";
import { type ScopedThreadRef, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "../connection/runtime";
import { useBtwPanelStore } from "../btwPanelStore";

export interface BtwThreadInput {
  readonly ref: ScopedThreadRef;
}

export interface BtwSendInput extends BtwThreadInput {
  readonly message: string;
  readonly model?: string | undefined;
}

export const loadBtwMessages = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:btw:list",
  concurrency: { mode: "singleFlight", key: (input: BtwThreadInput) => scopedThreadKey(input.ref) },
  execute: (input: BtwThreadInput) =>
    runInEnvironment(
      input.ref.environmentId,
      request(WS_METHODS.btwListMessages, { threadId: input.ref.threadId }),
    ).pipe(
      Effect.tap((result) =>
        Effect.sync(() =>
          useBtwPanelStore.getState().setLoadedMessages(
            input.ref,
            result.messages.map((message) => ({ role: message.role, content: message.content })),
          ),
        ),
      ),
    ),
});

export const clearBtwMessages = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:btw:clear",
  concurrency: { mode: "serial", key: (input: BtwThreadInput) => scopedThreadKey(input.ref) },
  execute: (input: BtwThreadInput) =>
    runInEnvironment(
      input.ref.environmentId,
      request(WS_METHODS.btwClear, { threadId: input.ref.threadId }),
    ).pipe(Effect.tap(() => Effect.sync(() => useBtwPanelStore.getState().clearLocal(input.ref)))),
});

export const sendBtwMessage = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:btw:send",
  concurrency: { mode: "serial", key: (input: BtwSendInput) => scopedThreadKey(input.ref) },
  execute: (input: BtwSendInput) =>
    runStreamInEnvironment(
      input.ref.environmentId,
      runStream(WS_METHODS.btwSendMessage, {
        threadId: input.ref.threadId,
        message: input.message,
        ...(input.model ? { model: input.model } : {}),
      }).pipe(
        Stream.tap((chunk) =>
          Effect.sync(() => {
            const store = useBtwPanelStore.getState();
            if (chunk.kind === "delta") {
              store.appendAssistantDelta(input.ref, chunk.text);
            } else {
              store.finishAssistant(input.ref, chunk.message.content);
            }
          }),
        ),
      ),
    ).pipe(Stream.runDrain),
});
