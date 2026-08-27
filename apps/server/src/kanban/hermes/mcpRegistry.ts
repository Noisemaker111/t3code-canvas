/**
 * The connected outbound MCP servers a tick may call.
 *
 * A module global for the same reason the rest of the Hermes wiring is one: the
 * prompt builder and the executor are both called from context-free code paths
 * that cannot be handed a service. `syncHermesMcpServers` is the only writer,
 * and the layer calls it at boot and on every settings change.
 *
 * A server that will not connect is kept here as unavailable, recorded as a
 * health incident, and named in the prompt — never dropped.
 *
 * @module kanban/hermes/mcpRegistry
 */
import type { HermesMcpServer } from "@t3tools/contracts";

import { recordDegradation } from "../../health/incidentLog.ts";
import { connectMcpServer, type McpConnection, type McpFetch } from "./mcpClient.ts";

/** What the prompt and the executor both read: who is up, and who is not. */
export type HermesMcpToolset = {
  readonly servers: ReadonlyArray<McpConnection>;
  readonly unavailable: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
};

const EMPTY: HermesMcpToolset = { servers: [], unavailable: [] };

let toolset: HermesMcpToolset = EMPTY;
let lastSignature: string | null = null;

export function hermesMcpToolset(): HermesMcpToolset {
  return toolset;
}

/** Test seam: drop every connection without going through settings. */
export function resetHermesMcpToolset(): void {
  toolset = EMPTY;
  lastSignature = null;
}

/**
 * Connect every enabled server and publish the result. Resolves even when a
 * server is down — the failure is on the incident log and in `unavailable`,
 * which is what makes it visible rather than silent.
 */
export async function syncHermesMcpServers(
  servers: ReadonlyArray<HermesMcpServer>,
  options: { readonly connect?: typeof connectMcpServer; readonly fetchImpl?: McpFetch } = {},
): Promise<HermesMcpToolset> {
  const connect = options.connect ?? connectMcpServer;
  // Any settings write streams through here. Re-dial only when the roster
  // changed — or when a server is still down, which is worth retrying.
  const signature = JSON.stringify(servers);
  if (signature === lastSignature && toolset.unavailable.length === 0) return toolset;
  lastSignature = signature;
  const connected: McpConnection[] = [];
  const unavailable: { name: string; reason: string }[] = [];
  for (const server of servers) {
    if (!server.enabled) continue;
    // A row added from Settings starts with no URL. Nothing has degraded yet —
    // it was never configured — but it still has to say so rather than vanish.
    if (server.url.trim().length === 0) {
      unavailable.push({ name: server.name, reason: "no URL set" });
      continue;
    }
    try {
      connected.push(
        await connect({
          server,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        }),
      );
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      unavailable.push({ name: server.name, reason });
      recordDegradation({
        id: `hermes.mcp.${server.name}`,
        title: `Hermes MCP server ${server.name} is unreachable`,
        detail: `${server.url}: ${reason}. Its tools are absent from the tick surface until it answers.`,
      });
    }
  }
  toolset = { servers: connected, unavailable };
  return toolset;
}
