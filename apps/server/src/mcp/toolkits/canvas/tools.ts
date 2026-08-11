/**
 * Canvas MCP tools for coding-agent threads.
 *
 * Every drawing lands in a titled frame of its own, laid out for the agent: a
 * model that had to compute x=400, y=400 on every call would either collide
 * with the human's work or drift off screen, and neither is something it should
 * be spending attention on.
 *
 * These ride the `kanban` capability rather than one of their own — the canvas
 * is the board's surface, and a thread allowed to move cards is allowed to draw.
 */
import {
  CanvasDigest,
  CanvasEdge,
  CanvasMessage,
  CanvasNode,
  PreviewAutomationUnavailableError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as CanvasStore from "../../../canvas/CanvasStore.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, CanvasStore.CanvasStore];

const CanvasMcpFailure = Schema.Union([
  PreviewAutomationUnavailableError,
  Schema.Struct({
    _tag: Schema.Literal("CanvasMcpError"),
    message: Schema.String,
  }),
]);

const canvasTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, false) as T;

const readonlyCanvasTool = <T extends Tool.Any>(tool: T): T =>
  canvasTool(tool).annotate(Tool.Readonly, true).annotate(Tool.Idempotent, true) as T;

export const CanvasReadTool = readonlyCanvasTool(
  Tool.make("canvas_read", {
    description:
      "Read what is on the board canvas: every shape carrying text, plus a count of the ones without (freehand, images). Read before drawing so you extend the picture instead of covering it.",
    parameters: Schema.Struct({}),
    success: Schema.Struct({ canvas: CanvasDigest }),
    failure: CanvasMcpFailure,
    dependencies,
  }).annotate(Tool.Title, "Read canvas"),
);

export const CanvasDrawTool = canvasTool(
  Tool.make("canvas_draw", {
    description:
      "Draw boxes and arrows on the board canvas — an architecture, a flow, what you found. The drawing lands in a titled frame of its own; omit x/y and it is laid out for you. Edges must name node keys from this same call. The browser renders it; you never author tldraw shapes.",
    parameters: Schema.Struct({
      title: Schema.String,
      nodes: Schema.Array(CanvasNode),
      edges: Schema.optional(Schema.Array(CanvasEdge)),
      note: Schema.optional(Schema.String),
    }),
    success: Schema.Struct({ id: Schema.String }),
    failure: CanvasMcpFailure,
    dependencies,
  }).annotate(Tool.Title, "Draw on canvas"),
);

export const CanvasPostTool = canvasTool(
  Tool.make("canvas_post", {
    description:
      "Send a message about the canvas — a comment, or a picture with a comment. Use it to show Hermes or the human something a diagram cannot say. Base64 image, no data-URL prefix. Addressed to Hermes unless you say otherwise.",
    parameters: Schema.Struct({
      text: Schema.String,
      target: Schema.optional(Schema.Literals(["hermes", "human"])),
      imageBase64: Schema.optional(Schema.String),
      imageMediaType: Schema.optional(Schema.Literals(["image/png", "image/jpeg", "image/webp"])),
    }),
    success: Schema.Struct({ id: Schema.String }),
    failure: CanvasMcpFailure,
    dependencies,
  }).annotate(Tool.Title, "Post canvas message"),
);

export const CanvasInboxTool = canvasTool(
  Tool.make("canvas_inbox", {
    description:
      "Messages a human or Hermes addressed to this thread and you have not read yet — a picture of what is wrong, a pointer to what to look at. Reading marks them delivered, so do something with what you get.",
    parameters: Schema.Struct({
      includeImages: Schema.optional(Schema.Boolean),
    }),
    success: Schema.Struct({ messages: Schema.Array(CanvasMessage) }),
    failure: CanvasMcpFailure,
    dependencies,
  }).annotate(Tool.Title, "Read canvas inbox"),
);

export const CanvasToolkit = Toolkit.make(
  CanvasReadTool,
  CanvasDrawTool,
  CanvasPostTool,
  CanvasInboxTool,
);
