import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { listCostResources, sumClaudeListCost, sumCodexListCost } from "./listCost.ts";

function tempHome(): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-list-cost-"));
}

describe("listCost", () => {
  it("builds listToday / listWeek resources from totals", () => {
    expect(listCostResources(null)).toEqual({});
    expect(listCostResources({ todayUsd: 0, weekUsd: 0 })).toEqual({});
    expect(listCostResources({ todayUsd: 1.2, weekUsd: 4 })).toEqual({
      listToday: { kind: "consumption", unit: "USD", used: 1.2 },
      listWeek: { kind: "consumption", unit: "USD", used: 4 },
    });
  });

  it("sums Claude assistant turns from project JSONL at list rates", async () => {
    const home = tempHome();
    const project = NodePath.join(home, ".claude", "projects", "demo");
    NodeFS.mkdirSync(project, { recursive: true });
    const nowMs = Date.parse("2026-07-25T12:00:00Z");
    NodeFS.writeFileSync(
      NodePath.join(project, "session.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-25T11:00:00Z",
          requestId: "r1",
          message: {
            id: "m1",
            model: "claude-sonnet-4-20250514",
            usage: {
              input_tokens: 1_000_000,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-20T11:00:00Z",
          requestId: "r2",
          message: {
            id: "m2",
            model: "claude-sonnet-4-20250514",
            usage: {
              input_tokens: 1_000_000,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        }),
      ].join("\n"),
    );
    // Touch mtime so the file is considered recent.
    const recent = nowMs / 1000;
    NodeFS.utimesSync(NodePath.join(project, "session.jsonl"), recent, recent);

    const totals = await sumClaudeListCost({ homeDir: home, nowMs });
    // Sonnet input $3 / 1M → $3 today + $3 earlier in week = $6 week.
    expect(totals).toEqual({ todayUsd: 3, weekUsd: 6 });
  });

  it("sums Codex token_count deltas from session JSONL at list rates", async () => {
    const home = tempHome();
    const sessions = NodePath.join(home, ".codex", "sessions", "2026");
    NodeFS.mkdirSync(sessions, { recursive: true });
    const nowMs = Date.parse("2026-07-25T12:00:00Z");
    NodeFS.writeFileSync(
      NodePath.join(sessions, "rollout.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-07-25T10:00:00Z",
          type: "session_meta",
          model: "gpt-5",
        }),
        JSON.stringify({
          timestamp: "2026-07-25T10:00:01Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 1_000_000,
                cached_input_tokens: 0,
                output_tokens: 0,
                reasoning_output_tokens: 0,
                total_tokens: 1_000_000,
              },
            },
          },
        }),
      ].join("\n"),
    );
    const recent = nowMs / 1000;
    NodeFS.utimesSync(NodePath.join(sessions, "rollout.jsonl"), recent, recent);

    const totals = await sumCodexListCost({ homeDir: home, nowMs });
    // gpt-5 input $1.25 / 1M.
    expect(totals).toEqual({ todayUsd: 1.25, weekUsd: 1.25 });
  });
});
