/**
 * Install-log runtime command — tails deploy/apply.sh's run log into
 * {@link useInstallLogStore}.
 *
 * Modelled on the btw streaming command: a runtime command whose execute
 * returns a stream, tapped into the store and drained. The one thing that is
 * special here is failure handling. Installing restarts the server, so the
 * stream WILL fail mid-run on every successful install — that is expected, not
 * an error. The caller re-invokes with `fromLine` set to the last line it saw
 * once the socket is back.
 */
import { runStream } from "@t3tools/client-runtime/rpc";
import {
  createRuntimeCommand,
  runStreamInEnvironment,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "../connection/runtime";
import { useInstallLogStore } from "../installLogStore";

export interface SubscribeInstallLogInput {
  readonly environmentId: EnvironmentId;
  /** Resume point; 0 replays the whole run. */
  readonly fromLine: number;
  /**
   * Run to tail. Pinning it is what keeps a reconnect — or a second install
   * started elsewhere — from splicing another run's lines into this pane.
   */
  readonly runId?: string | undefined;
}

export const subscribeInstallLog = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:install-log:subscribe",
  // One tail at a time — a second subscription would double every line.
  concurrency: { mode: "serial", key: () => "install-log" },
  execute: (input: SubscribeInstallLogInput) =>
    runStreamInEnvironment(
      input.environmentId,
      runStream(WS_METHODS.serverSubscribeInstallLog, {
        fromLine: input.fromLine,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
      }).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            useInstallLogStore.getState().append([event]);
          }),
        ),
      ),
    ).pipe(
      Stream.runDrain,
      Effect.tap(() => Effect.sync(() => useInstallLogStore.getState().setStreaming(false))),
      // The server going away mid-install is the normal path, so this must not
      // surface as an error toast. The subscriber loop retries.
      Effect.catchCause(() => Effect.sync(() => useInstallLogStore.getState().setStreaming(false))),
    ),
});
