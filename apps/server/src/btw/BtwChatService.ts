/**
 * BtwChatService — streaming chat model for the btw side-chat.
 *
 * Reuses the repo's existing Claude CLI infrastructure (the same
 * `ChildProcessSpawner` + `makeClaudeEnvironment` helpers used by
 * `ClaudeTextGeneration`) — no new SDK. The CLI is run in streaming NDJSON mode
 * (`--output-format stream-json --include-partial-messages`) and each
 * `content_block_delta` text delta is forwarded as it arrives, giving
 * token-by-token streaming.
 *
 * The model is selectable via a slug and defaults to a small/cheap model.
 *
 * @module btw/BtwChatService
 */
import { BtwChatError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import { inAgentSlice } from "../process/agentSlice.ts";

/** Small/cheap default model for the btw chat. */
export const DEFAULT_BTW_MODEL = "claude-haiku-4-5";

export interface BtwChatReplyInput {
  /** Fully composed prompt (system + btw history + new message). */
  readonly prompt: string;
  /** Model slug; defaults to {@link DEFAULT_BTW_MODEL}. */
  readonly model?: string | undefined;
  /** Optional working directory for the CLI. */
  readonly cwd?: string | undefined;
}

export interface BtwChatServiceShape {
  /**
   * Stream the assistant reply token-by-token. Each emitted string is an
   * incremental slice of assistant text.
   */
  readonly streamReply: (input: BtwChatReplyInput) => Stream.Stream<string, BtwChatError>;
}

export class BtwChatService extends Context.Service<BtwChatService, BtwChatServiceShape>()(
  "t3/btw/BtwChatService",
) {}

const toBtwChatError =
  (detail: string) =>
  (cause: unknown): BtwChatError =>
    new BtwChatError({ message: detail, cause });

/**
 * Extract assistant text from one NDJSON line emitted by
 * `claude --output-format stream-json`. Prefers incremental `text_delta`s; if
 * the CLI never emits partial deltas we fall back to the final `assistant`
 * message text (guarded so we never double-count).
 */
const extractLineText = (line: string, sawDelta: boolean): string | null => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  if (record["type"] === "stream_event") {
    const event = record["event"] as Record<string, unknown> | undefined;
    if (event?.["type"] === "content_block_delta") {
      const delta = event["delta"] as Record<string, unknown> | undefined;
      if (delta?.["type"] === "text_delta" && typeof delta["text"] === "string") {
        return delta["text"];
      }
    }
    return null;
  }

  if (record["type"] === "assistant" && !sawDelta) {
    const message = record["message"] as Record<string, unknown> | undefined;
    const content = message?.["content"];
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (block): block is { type: "text"; text: string } =>
            typeof block === "object" &&
            block !== null &&
            (block as Record<string, unknown>)["type"] === "text" &&
            typeof (block as Record<string, unknown>)["text"] === "string",
        )
        .map((block) => block.text)
        .join("");
      return text.length > 0 ? text : null;
    }
  }

  return null;
};

const makeBtwChatService = Effect.gen(function* () {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  // Default Claude config: empty homePath leaves the ambient CLI auth intact.
  const claudeEnvironment = yield* makeClaudeEnvironment({ homePath: "" }).pipe(
    Effect.provideService(Path.Path, path),
  );

  const streamReply: BtwChatServiceShape["streamReply"] = (input) =>
    Stream.callback<string, BtwChatError>((queue) =>
      Effect.gen(function* () {
        const model =
          input.model && input.model.trim().length > 0 ? input.model : DEFAULT_BTW_MODEL;
        const args = [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--model",
          model,
          "--dangerously-skip-permissions",
        ];
        const sliced = inAgentSlice({ command: "claude", args });
        const command = ChildProcess.make(sliced.command, [...sliced.args], {
          env: claudeEnvironment,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          shell: false,
          stdin: {
            stream: Stream.encodeText(Stream.make(input.prompt)),
          },
        });

        const child = yield* commandSpawner.spawn(command);
        const remainderRef = yield* Ref.make("");
        const sawDeltaRef = yield* Ref.make(false);

        const processLine = (line: string) =>
          Effect.gen(function* () {
            const sawDelta = yield* Ref.get(sawDeltaRef);
            const text = extractLineText(line, sawDelta);
            if (text === null) return;
            if (!sawDelta) yield* Ref.set(sawDeltaRef, true);
            yield* Queue.offer(queue, text);
          });

        // Drain stderr so the pipe never blocks the child.
        yield* child.stderr.pipe(Stream.decodeText(), Stream.runDrain, Effect.forkScoped);

        yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            Ref.modify(remainderRef, (current) => {
              const combined = current + chunk;
              const lines = combined.split("\n");
              const remainder = lines.pop() ?? "";
              return [lines.map((line) => line.replace(/\r$/, "")), remainder] as const;
            }).pipe(
              Effect.flatMap((lines) => Effect.forEach(lines, processLine, { discard: true })),
            ),
          ),
          Effect.andThen(
            Ref.get(remainderRef).pipe(
              Effect.flatMap((remainder) =>
                remainder.trim().length > 0 ? processLine(remainder) : Effect.void,
              ),
            ),
          ),
          Effect.andThen(Queue.end(queue)),
          Effect.catchCause((cause) =>
            Queue.fail(
              queue,
              new BtwChatError({ message: "The btw chat model stream failed.", cause }),
            ),
          ),
          Effect.forkScoped,
        );
      }).pipe(Effect.mapError(toBtwChatError("Failed to start the btw chat model."))),
    );

  return { streamReply } satisfies BtwChatServiceShape;
});

export const BtwChatServiceLive = Layer.effect(BtwChatService, makeBtwChatService);
