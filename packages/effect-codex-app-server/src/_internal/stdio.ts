import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as CodexError from "../errors.ts";

const encoder = new TextEncoder();

export const makeChildStdio = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  Stdio.make({
    args: Effect.succeed([]),
    stdin: handle.stdout,
    stdout: () =>
      Sink.mapInput(handle.stdin, (chunk: string | Uint8Array) =>
        typeof chunk === "string" ? encoder.encode(chunk) : chunk,
      ),
    stderr: () => Sink.drain,
  });

export const makeInMemoryStdio = Effect.fn("makeInMemoryStdio")(function* () {
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const output = yield* Queue.unbounded<string>();
  const decoder = new TextDecoder();

  return {
    stdio: Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(input),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Queue.offer(
            output,
            typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }),
          ),
        ),
      stderr: () => Sink.drain,
    }),
    input,
    output,
  };
});

type ChildProcessTerminationHandle = Pick<
  ChildProcessSpawner.ChildProcessHandle,
  "exitCode" | "pid"
>;

// Keep the most recent slice of stderr so a non-zero exit can report the reason
// without buffering unbounded diagnostics (the app server can stream megabytes).
const STDERR_TAIL_MAX_CHARS = 4000;

export interface ChildStderrCapture {
  readonly append: (chunk: Uint8Array | string) => void;
  readonly getTail: () => string;
}

export const makeChildStderrCapture = (): ChildStderrCapture => {
  const decoder = new TextDecoder();
  let tail = "";
  return {
    append: (chunk) => {
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      if (text.length === 0) return;
      tail = (tail + text).slice(-STDERR_TAIL_MAX_CHARS);
    },
    getTail: () => tail.trim(),
  };
};

export const makeTerminationError = (
  handle: ChildProcessTerminationHandle,
  getStderrTail?: () => string,
): Effect.Effect<CodexError.CodexAppServerError> =>
  Effect.match(handle.exitCode, {
    onFailure: (cause) =>
      new CodexError.CodexAppServerTransportError({
        operation: "read-process-exit-status",
        pid: handle.pid,
        cause,
      }),
    onSuccess: (code) => {
      const stderr = getStderrTail?.();
      return new CodexError.CodexAppServerProcessExitedError({
        code,
        pid: handle.pid,
        ...(stderr ? { stderr } : {}),
      });
    },
  });
