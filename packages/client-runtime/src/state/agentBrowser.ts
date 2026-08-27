import { WS_METHODS, type AgentBrowserSessionSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";
import { agentBrowserFrameKey, publishAgentBrowserFrame } from "./agentBrowserFrames.ts";
import {
  applyAgentBrowserAttachStreamEvent,
  applyAgentBrowserSessionsStreamEvent,
  EMPTY_AGENT_BROWSER_VIEW_STATE,
} from "./agentBrowserSession.ts";

export function createAgentBrowserEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const lifecycleConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };
  return {
    attach: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:browser:attach",
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.browserAttach>) => {
        const frameKey = agentBrowserFrameKey(input);
        // Frames leave the stream here, before anything reactive sees them: the
        // painter reads them from its own mailbox, and this subscription only
        // ever emits when the *tab* changes — navigation, title, close.
        return subscribe(WS_METHODS.browserAttach, input).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              if (event.type === "frame") publishAgentBrowserFrame(frameKey, event.frame);
            }),
          ),
          Stream.filter((event) => event.type !== "frame"),
          Stream.scan(EMPTY_AGENT_BROWSER_VIEW_STATE, applyAgentBrowserAttachStreamEvent),
        );
      },
    }),
    sessions: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:browser:sessions",
      subscribe: (_input: null) =>
        subscribe(WS_METHODS.subscribeBrowserSessions, {}).pipe(
          Stream.scan(
            [] as ReadonlyArray<AgentBrowserSessionSummary>,
            applyAgentBrowserSessionsStreamEvent,
          ),
        ),
    }),
    /** The box's cookie jars. Refetched when a tab is opened in a new one. */
    profiles: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:browser:profiles",
      tag: WS_METHODS.browserProfiles,
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:browser:open",
      tag: WS_METHODS.browserOpen,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    navigate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:browser:navigate",
      tag: WS_METHODS.browserNavigate,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    history: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:browser:history",
      tag: WS_METHODS.browserHistory,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    input: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:browser:input",
      tag: WS_METHODS.browserInput,
    }),
    resize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:browser:resize",
      tag: WS_METHODS.browserResize,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:browser:close",
      tag: WS_METHODS.browserClose,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
  };
}

export * from "./agentBrowserFrames.ts";
export * from "./agentBrowserSession.ts";
