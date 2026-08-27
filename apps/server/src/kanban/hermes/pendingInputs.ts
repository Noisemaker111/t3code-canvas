/**
 * Server-side port of `derivePendingUserInputs` (`apps/web/src/session-logic.ts`).
 *
 * A thread blocked on a tool-permission question sits idle until a human
 * notices, so Hermes needs the same derivation the client already does.
 *
 * @module kanban/hermes/pendingInputs
 */
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import type { BoardPendingInput } from "./boardApi.ts";

type OpenRequest = {
  requestId: string;
  createdAt: string;
  question: string;
  options: ReadonlyArray<string>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstQuestion(
  payload: Record<string, unknown>,
): Omit<OpenRequest, "requestId" | "createdAt"> | null {
  const questions = payload.questions;
  if (!Array.isArray(questions)) return null;
  for (const raw of questions) {
    const question = record(raw);
    if (!question) continue;
    const text = typeof question.question === "string" ? question.question : null;
    const rawOptions = Array.isArray(question.options) ? question.options : [];
    const options = rawOptions
      .map((option) => {
        const parsed = record(option);
        return parsed && typeof parsed.label === "string" ? parsed.label : null;
      })
      .filter((label): label is string => label !== null);
    if (text && options.length > 0) return { question: text, options };
  }
  return null;
}

const STALE_FAILURE = /(?:no pending|unknown request|already (?:answered|resolved)|stale)/i;

export function derivePendingInputsForThread(input: {
  readonly threadId: string;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}): ReadonlyArray<BoardPendingInput> {
  const open = new Map<string, OpenRequest>();
  const ordered = [...input.activities].toSorted((left, right) =>
    (left.sequence ?? 0) === (right.sequence ?? 0)
      ? left.createdAt.localeCompare(right.createdAt)
      : (left.sequence ?? 0) - (right.sequence ?? 0),
  );

  for (const activity of ordered) {
    const payload = record(activity.payload);
    if (!payload) continue;
    const requestId = typeof payload.requestId === "string" ? payload.requestId : null;
    if (!requestId) continue;

    if (activity.kind === "user-input.requested") {
      const parsed = firstQuestion(payload);
      if (parsed) {
        open.set(requestId, { requestId, createdAt: activity.createdAt, ...parsed });
      }
      continue;
    }
    if (activity.kind === "user-input.resolved") {
      open.delete(requestId);
      continue;
    }
    if (
      activity.kind === "provider.user-input.respond.failed" &&
      typeof payload.detail === "string" &&
      STALE_FAILURE.test(payload.detail)
    ) {
      open.delete(requestId);
    }
  }

  return [...open.values()]
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((entry) => ({
      threadId: input.threadId,
      requestId: entry.requestId,
      question: entry.question,
      options: entry.options,
    }));
}
