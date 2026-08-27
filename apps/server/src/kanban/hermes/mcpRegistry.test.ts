import * as NodeOS from "node:os";

import { beforeEach, describe, expect, it } from "@effect/vitest";

import type { HermesMcpServer } from "@t3tools/contracts";

import {
  bindHealthIncidentLog,
  readHealthIncidents,
  unbindHealthIncidentLog,
} from "../../health/incidentLog.ts";
import { connectMcpServer, McpServerError, type McpFetch } from "./mcpClient.ts";
import { hermesMcpToolset, resetHermesMcpToolset, syncHermesMcpServers } from "./mcpRegistry.ts";

const server = (over: Partial<HermesMcpServer> = {}): HermesMcpServer => ({
  name: "docs",
  url: "https://mcp.example/mcp",
  headers: {},
  enabled: true,
  ...over,
});

/** A server that answers the three handshake calls and one tool call. */
const fakeFetch = (
  tools: ReadonlyArray<unknown>,
  onCall?: (body: unknown) => unknown,
): McpFetch => {
  return async (_url, init) => {
    const request = JSON.parse(init.body) as { method: string; params?: unknown };
    const result =
      request.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake" } }
        : request.method === "tools/list"
          ? { tools }
          : { structuredContent: onCall?.(request.params) ?? { ok: true } };
    return {
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === "content-type" ? "application/json" : null) },
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
    };
  };
};

const searchTool = {
  name: "search",
  description: "Search the docs",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "number" } },
    required: ["query"],
  },
};

describe("connectMcpServer", () => {
  it("handshakes and reads the advertised tools", async () => {
    const connection = await connectMcpServer({
      server: server(),
      fetchImpl: fakeFetch([searchTool]),
    });

    expect(connection.tools.map((tool) => tool.name)).toEqual(["search"]);
    expect(await connection.call("search", { query: "hermes" })).toEqual({ ok: true });
  });

  it("fails by name when the server answers a JSON-RPC error", async () => {
    const fetchImpl: McpFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () =>
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "no thanks" } }),
    });

    await expect(connectMcpServer({ server: server(), fetchImpl })).rejects.toThrow(/no thanks/);
  });

  it("turns an isError tool result into a thrown failure", async () => {
    const fetchImpl: McpFetch = async (_url, init) => {
      const request = JSON.parse(init.body) as { method: string };
      const result =
        request.method === "tools/list"
          ? { tools: [searchTool] }
          : request.method === "tools/call"
            ? { isError: true, content: [{ type: "text", text: "index is cold" }] }
            : {};
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
      };
    };
    const connection = await connectMcpServer({ server: server(), fetchImpl });

    await expect(connection.call("search", {})).rejects.toThrow(/index is cold/);
  });
});

describe("syncHermesMcpServers", () => {
  let dir: string;
  let dirSeq = 0;

  beforeEach(() => {
    resetHermesMcpToolset();
    unbindHealthIncidentLog();
    dirSeq += 1;
    dir = `${NodeOS.tmpdir()}/hermes-mcp-${process.pid}-${dirSeq}`;
    bindHealthIncidentLog(dir);
  });

  it("publishes the tools of a server that connects", async () => {
    await syncHermesMcpServers([server()], { fetchImpl: fakeFetch([searchTool]) });

    expect(hermesMcpToolset().servers.map((entry) => entry.name)).toEqual(["docs"]);
    expect(hermesMcpToolset().unavailable).toEqual([]);
  });

  it("records a degradation and marks the server unavailable when it will not connect", async () => {
    const toolset = await syncHermesMcpServers([server()], {
      connect: async () => {
        throw new McpServerError("docs", "could not reach https://mcp.example/mcp: ECONNREFUSED");
      },
    });

    expect(toolset.servers).toEqual([]);
    expect(toolset.unavailable).toEqual([
      { name: "docs", reason: "could not reach https://mcp.example/mcp: ECONNREFUSED" },
    ]);
    const incidents = readHealthIncidents(10);
    expect(incidents.some((incident) => incident.id === "degraded.hermes.mcp.docs")).toBe(true);
    expect(incidents.at(-1)?.detail).toContain("ECONNREFUSED");
  });

  it("names a server with no URL unavailable without dialling or filing an incident", async () => {
    let dialled = 0;
    await syncHermesMcpServers([server({ url: "" })], {
      connect: async () => {
        dialled += 1;
        throw new Error("should not dial");
      },
    });

    expect(dialled).toBe(0);
    expect(hermesMcpToolset().unavailable).toEqual([{ name: "docs", reason: "no URL set" }]);
    expect(
      readHealthIncidents(10).some((incident) => incident.id === "degraded.hermes.mcp.docs"),
    ).toBe(false);
  });

  it("skips a disabled server without calling it", async () => {
    let dialled = 0;
    await syncHermesMcpServers([server({ enabled: false })], {
      connect: async () => {
        dialled += 1;
        throw new Error("should not dial");
      },
    });

    expect(dialled).toBe(0);
    expect(hermesMcpToolset().servers).toEqual([]);
  });
});
