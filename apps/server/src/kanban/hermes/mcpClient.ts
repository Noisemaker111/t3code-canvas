/**
 * Outbound MCP client — the other direction from `apps/server/src/mcp/`, which
 * serves board toolkits to agent threads. This one dials a configured server so
 * a Hermes tick program can call its tools.
 *
 * Streamable HTTP only: one POST per JSON-RPC request, answering with either
 * `application/json` or a `text/event-stream` carrying the same envelope.
 *
 * @module kanban/hermes/mcpClient
 */
import type { HermesMcpServer } from "@t3tools/contracts";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_NAME = "t3code-hermes";
const REQUEST_TIMEOUT_MS = 20_000;

/** One tool as its server advertises it. `inputSchema` is raw JSON Schema. */
export type McpToolSpec = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
};

/** A live server: what it offers, and how to call it. */
export type McpConnection = {
  readonly name: string;
  readonly url: string;
  readonly tools: ReadonlyArray<McpToolSpec>;
  readonly call: (tool: string, args: unknown) => Promise<unknown>;
};

export class McpServerError extends Error {
  readonly server: string;

  constructor(server: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "McpServerError";
    this.server = server;
  }
}

export type McpFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { readonly get: (name: string) => string | null };
  readonly text: () => Promise<string>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

/** An SSE body carries the same JSON-RPC envelope on its `data:` lines. */
function parseEnvelope(server: string, contentType: string, body: string): Record<string, unknown> {
  const payloads = contentType.includes("text/event-stream")
    ? body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
    : [body.trim()];
  for (const payload of payloads) {
    if (payload.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch (cause) {
      throw new McpServerError(server, `answered with unparseable JSON-RPC`, cause);
    }
    if (isRecord(parsed) && ("result" in parsed || "error" in parsed)) return parsed;
  }
  throw new McpServerError(server, "answered with no JSON-RPC result");
}

function readToolSpecs(server: string, result: unknown): ReadonlyArray<McpToolSpec> {
  if (!isRecord(result) || !Array.isArray(result.tools)) {
    throw new McpServerError(server, "tools/list did not answer with a tools array");
  }
  const tools: McpToolSpec[] = [];
  for (const entry of result.tools) {
    if (!isRecord(entry)) continue;
    const name = readString(entry, "name");
    if (name === null || name.length === 0) continue;
    tools.push({
      name,
      description: readString(entry, "description") ?? readString(entry, "title") ?? "",
      inputSchema: entry.inputSchema ?? null,
    });
  }
  return tools;
}

/**
 * Connect, handshake and read the tool list. Rejects with `McpServerError` on
 * any step — a half-connected server is not a server.
 */
export async function connectMcpServer(input: {
  readonly server: HermesMcpServer;
  readonly fetchImpl?: McpFetch;
  readonly timeoutMs?: number;
}): Promise<McpConnection> {
  const { server } = input;
  const doFetch = input.fetchImpl ?? (globalThis.fetch as unknown as McpFetch);
  const timeoutMs = input.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let sessionId: string | null = null;
  let nextId = 0;

  const send = async (method: string, params: unknown, notification = false): Promise<unknown> => {
    const id = notification ? null : ++nextId;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      ...server.headers,
    };
    if (sessionId !== null) headers["mcp-session-id"] = sessionId;
    let response: Awaited<ReturnType<McpFetch>>;
    try {
      response = await doFetch(server.url, {
        method: "POST",
        headers,
        body: JSON.stringify(
          notification
            ? { jsonrpc: "2.0", method, params }
            : { jsonrpc: "2.0", id, method, params },
        ),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new McpServerError(
        server.name,
        `${method} could not reach ${server.url}: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      );
    }
    const received = response.headers.get("mcp-session-id");
    if (received !== null && received.length > 0) sessionId = received;
    if (!response.ok) {
      throw new McpServerError(server.name, `${method} answered HTTP ${response.status}`);
    }
    if (notification) return null;
    const body = await response.text();
    const envelope = parseEnvelope(server.name, response.headers.get("content-type") ?? "", body);
    const failure = envelope.error;
    if (failure !== undefined) {
      const message = isRecord(failure) ? (readString(failure, "message") ?? "") : "";
      throw new McpServerError(
        server.name,
        `${method} failed: ${message.length > 0 ? message : JSON.stringify(failure)}`,
      );
    }
    return envelope.result;
  };

  await send("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: CLIENT_NAME, version: PROTOCOL_VERSION },
  });
  await send("notifications/initialized", {}, true);
  const tools = readToolSpecs(server.name, await send("tools/list", {}));

  return {
    name: server.name,
    url: server.url,
    tools,
    call: async (tool: string, args: unknown) => {
      const result = await send("tools/call", {
        name: tool,
        arguments: args === undefined || args === null ? {} : args,
      });
      if (isRecord(result) && result.isError === true) {
        const content = Array.isArray(result.content) ? result.content : [];
        const text = content
          .map((block) => (isRecord(block) ? (readString(block, "text") ?? "") : ""))
          .filter((line) => line.length > 0)
          .join("\n");
        throw new McpServerError(
          server.name,
          `${tool} failed: ${text.length > 0 ? text : "the server reported an error"}`,
        );
      }
      if (isRecord(result) && result.structuredContent !== undefined)
        return result.structuredContent;
      return result ?? null;
    },
  };
}
