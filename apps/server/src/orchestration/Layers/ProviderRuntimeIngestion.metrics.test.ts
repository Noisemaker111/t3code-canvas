import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

const THREAD_ID = ThreadId.make("thread-1");

function payloadOf(activity: { payload: unknown } | undefined): Record<string, unknown> {
  expect(activity).toBeDefined();
  return activity!.payload as Record<string, unknown>;
}

describe("runtimeEventToActivities metrics", () => {
  it("stamps itemId, tokens, and the server-measured span on tool completion", () => {
    const event = {
      type: "item.completed",
      eventId: EventId.make("evt-complete"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-07-18T00:00:09.000Z",
      threadId: THREAD_ID,
      itemId: RuntimeItemId.make("item-1"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Ran command",
        detail: "ls -la\ntotal 42",
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event, undefined, {
      startedAt: "2026-07-18T00:00:01.500Z",
      durationMs: 7_500,
    });

    const payload = payloadOf(activity);
    expect(activity?.kind).toBe("tool.completed");
    expect(payload.itemId).toBe("item-1");
    expect(payload.status).toBe("completed");
    expect(payload.startedAt).toBe("2026-07-18T00:00:01.500Z");
    expect(payload.durationMs).toBe(7_500);
    expect(typeof payload.tokens).toBe("number");
    expect(payload.tokens as number).toBeGreaterThan(0);
  });

  it("counts tokens and closes the span on a terminal item.updated", () => {
    const event = {
      type: "item.updated",
      eventId: EventId.make("evt-updated"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-07-18T00:00:05.000Z",
      threadId: THREAD_ID,
      itemId: RuntimeItemId.make("item-2"),
      payload: {
        itemType: "command_execution",
        status: "failed",
        title: "Ran command",
        detail: "boom: exit 1",
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event, undefined, { durationMs: 3_000 });

    const payload = payloadOf(activity);
    expect(payload.itemId).toBe("item-2");
    expect(payload.durationMs).toBe(3_000);
    expect(payload.tokens as number).toBeGreaterThan(0);
  });

  it("leaves in-flight item.updated without tokens or a span", () => {
    const event = {
      type: "item.updated",
      eventId: EventId.make("evt-inflight"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-07-18T00:00:05.000Z",
      threadId: THREAD_ID,
      itemId: RuntimeItemId.make("item-3"),
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "Ran command",
        detail: "ls -la",
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event, undefined, { durationMs: 1_000 });

    const payload = payloadOf(activity);
    expect(payload.tokens).toBeUndefined();
    expect(payload.durationMs).toBeUndefined();
  });

  it("turns a completed reasoning item into a thought row with tokens and time", () => {
    const event = {
      type: "item.completed",
      eventId: EventId.make("evt-thought"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-07-18T00:00:12.000Z",
      threadId: THREAD_ID,
      itemId: RuntimeItemId.make("item-think"),
      payload: {
        itemType: "reasoning",
        status: "completed",
        title: "Thought",
        detail: "Weighing the options.\nThe second line of the thought.",
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event, undefined, {
      startedAt: "2026-07-18T00:00:04.000Z",
      durationMs: 8_000,
    });

    const payload = payloadOf(activity);
    expect(activity?.kind).toBe("thought");
    expect(activity?.summary).toBe("Weighing the options.");
    expect(payload.itemId).toBe("item-think");
    expect(payload.durationMs).toBe(8_000);
    expect(payload.tokens as number).toBeGreaterThan(0);
    expect(payload.detail).toContain("second line");
  });

  it("drops empty reasoning completions", () => {
    const event = {
      type: "item.completed",
      eventId: EventId.make("evt-thought-empty"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-07-18T00:00:12.000Z",
      threadId: THREAD_ID,
      itemId: RuntimeItemId.make("item-think-2"),
      payload: {
        itemType: "reasoning",
        status: "completed",
        title: "Thought",
      },
    } satisfies ProviderRuntimeEvent;

    expect(runtimeEventToActivities(event)).toHaveLength(0);
  });

  it("stamps per-step task tokens on task.progress", () => {
    const event = {
      type: "task.progress",
      eventId: EventId.make("evt-task-progress"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-07-18T00:00:20.000Z",
      threadId: THREAD_ID,
      payload: {
        taskId: RuntimeTaskId.make("task-1"),
        description: "Exploring the repo",
        usage: { output_tokens: 900, input_tokens: 12_000 },
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event, undefined, { taskTokens: 350 });

    expect(payloadOf(activity).tokens).toBe(350);
  });

  it("stamps total task tokens and duration on task.completed", () => {
    const event = {
      type: "task.completed",
      eventId: EventId.make("evt-task-complete"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-07-18T00:01:00.000Z",
      threadId: THREAD_ID,
      payload: {
        taskId: RuntimeTaskId.make("task-1"),
        status: "completed",
        summary: "Explored the repo",
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event, "Explore repo", {
      startedAt: "2026-07-18T00:00:10.000Z",
      durationMs: 50_000,
      taskTokens: 2_400,
    });

    const payload = payloadOf(activity);
    expect(payload.tokens).toBe(2_400);
    expect(payload.durationMs).toBe(50_000);
    expect(payload.startedAt).toBe("2026-07-18T00:00:10.000Z");
  });
});
