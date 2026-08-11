/**
 * Handlers for the canvas MCP toolkit — thin wrappers over CanvasStore, with
 * the calling thread supplying every default the tools deliberately omit.
 */
import {
  CANVAS_MESSAGE_MAX_IMAGE_BYTES,
  type CanvasEdge,
  type CanvasImage,
  type CanvasNode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CanvasStore } from "../../../canvas/CanvasStore.ts";
import { wakeForCanvasMessage } from "../../../kanban/hermes/boardWake.ts";
import { CanvasToolkit } from "./tools.ts";

const mcpError = (message: string) => Effect.fail({ _tag: "CanvasMcpError" as const, message });

const requireCanvas = () => McpInvocationContext.requireMcpCapability("kanban");

const storeError = (operation: string) => (cause: { message?: string }) => ({
  _tag: "CanvasMcpError" as const,
  message: cause.message ?? `canvas ${operation} failed`,
});

const handlers = {
  canvas_read: () =>
    Effect.gen(function* () {
      yield* requireCanvas();
      const store = yield* CanvasStore;
      const canvas = yield* store.digest().pipe(Effect.mapError(storeError("digest")));
      return { canvas };
    }),

  canvas_draw: (input: {
    readonly title: string;
    readonly nodes: ReadonlyArray<CanvasNode>;
    readonly edges?: ReadonlyArray<CanvasEdge> | undefined;
    readonly note?: string | undefined;
  }) =>
    Effect.gen(function* () {
      yield* requireCanvas();
      const store = yield* CanvasStore;
      if (input.nodes.length === 0) return yield* mcpError("a drawing needs at least one node");
      const keys = new Set(input.nodes.map((node) => node.key));
      const dangling = (input.edges ?? []).find(
        (edge) => !keys.has(edge.from) || !keys.has(edge.to),
      );
      if (dangling) {
        return yield* mcpError(
          `edge ${dangling.from} → ${dangling.to} names a node that is not in this drawing`,
        );
      }
      const injection = yield* store
        .enqueueInjection({
          spec: {
            title: input.title,
            nodes: input.nodes,
            edges: input.edges ?? [],
            ...(input.note === undefined ? {} : { note: input.note }),
            // A coding agent drawing must never yank the human's viewport while
            // they are looking somewhere else.
            focus: false,
          },
        })
        .pipe(Effect.mapError(storeError("enqueueInjection")));
      return { id: injection.id };
    }),

  canvas_post: (input: {
    readonly text: string;
    readonly target?: "hermes" | "human" | undefined;
    readonly imageBase64?: string | undefined;
    readonly imageMediaType?: "image/png" | "image/jpeg" | "image/webp" | undefined;
  }) =>
    Effect.gen(function* () {
      const invocation = yield* requireCanvas();
      const store = yield* CanvasStore;
      const image: CanvasImage | null =
        input.imageBase64 === undefined || input.imageBase64.length === 0
          ? null
          : { mediaType: input.imageMediaType ?? "image/png", data: input.imageBase64 };
      if (image !== null && image.data.length > CANVAS_MESSAGE_MAX_IMAGE_BYTES) {
        return yield* mcpError(
          `image is ${image.data.length} bytes, over the ${CANVAS_MESSAGE_MAX_IMAGE_BYTES} cap`,
        );
      }
      const posted = yield* store
        .postMessage({
          authorKind: "thread",
          authorId: String(invocation.threadId),
          text: input.text,
          image,
          target: input.target ?? "hermes",
        })
        .pipe(Effect.mapError(storeError("postMessage")));
      wakeForCanvasMessage({ target: input.target ?? "hermes" });
      return { id: posted.message.id };
    }),

  canvas_inbox: (input: { readonly includeImages?: boolean | undefined }) =>
    Effect.gen(function* () {
      const invocation = yield* requireCanvas();
      const store = yield* CanvasStore;
      const listed = yield* store
        .listMessages({
          target: "thread",
          targetId: String(invocation.threadId),
          undeliveredOnly: true,
          includeImages: input.includeImages === true,
        })
        .pipe(Effect.mapError(storeError("listMessages")));
      if (listed.messages.length > 0) {
        yield* store
          .ackMessages({ ids: listed.messages.map((message) => message.id) })
          .pipe(Effect.mapError(storeError("ackMessages")));
      }
      return { messages: listed.messages };
    }),
} satisfies Parameters<typeof CanvasToolkit.toLayer>[0];

export const CanvasToolkitHandlersLive = CanvasToolkit.toLayer(handlers);
