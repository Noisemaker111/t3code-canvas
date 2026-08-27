import { createAgentBrowserEnvironmentAtoms } from "@t3tools/client-runtime/state/agentBrowser";
import type { AgentBrowserSessionSummary } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { usePrimaryEnvironment } from "./environments";
import { useEnvironmentQuery } from "./query";

export const agentBrowserEnvironment = createAgentBrowserEnvironmentAtoms(connectionAtomRuntime);

/**
 * Live roster of server browser tabs, `undefined` until the first snapshot —
 * callers must not reap panels against an unknown roster.
 */
export function useAgentBrowserSessions(): ReadonlyArray<AgentBrowserSessionSummary> | undefined {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : agentBrowserEnvironment.sessions({ environmentId, input: null }),
  );
  return query.data ?? undefined;
}
