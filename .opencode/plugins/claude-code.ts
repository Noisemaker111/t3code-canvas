/**
 * Project-local OpenCode V2 registration for the official Claude Code CLI.
 * This is intentionally a tool, not a provider/model: Claude owns auth and
 * subscription access, while OpenCode only owns the invocation boundary.
 */
import {
  runClaudeCode,
  type ClaudePermissionMode,
} from "../../apps/server/src/provider/ClaudeCodeBridge.ts";

type ToolContext = { readonly sessionID?: string; readonly signal?: AbortSignal };
type ClaudeCodeInput = {
  readonly prompt: string;
  readonly cwd?: string;
  readonly resume?: boolean;
  readonly sessionKey?: string;
  readonly model?: string;
  readonly permissionMode?: ClaudePermissionMode;
};

type ClaudeRunner = typeof runClaudeCode;

export const makeClaudeCodeTool = (run: ClaudeRunner = runClaudeCode) =>
  ({
    name: "claude_code",
    description:
      "Run the user's installed official Claude Code client (headless). Claude Code owns login, subscription, sessions, rate limits, and network traffic; this is not an OpenCode provider.",
    input: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The task or question to send to Claude Code." },
        cwd: {
          type: "string",
          description: "Workspace directory (defaults to the current OpenCode workspace).",
        },
        resume: { type: "boolean", description: "Resume the mapped session for sessionKey." },
        sessionKey: {
          type: "string",
          description: "Stable OpenCode thread key used for local resume mapping.",
        },
        model: { type: "string", description: "Documented Claude Code model name, if desired." },
        permissionMode: {
          type: "string",
          enum: ["default", "acceptEdits", "plan", "dontAsk"],
          description:
            "Claude Code permission mode. Elevated bypassPermissions is intentionally unavailable here.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    execute: async (input: ClaudeCodeInput, context?: ToolContext) => {
      const sessionKey = input.sessionKey || context?.sessionID;
      const result = await run({
        cwd: input.cwd?.trim() || process.cwd(),
        prompt: input.prompt,
        resume: input.resume === true,
        ...(sessionKey ? { sessionKey } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
        ...(context?.signal ? { signal: context.signal } : {}),
      });
      const progress = result.events
        .filter((event) => event.type === "status" || event.type === "tool")
        .map((event) =>
          event.type === "tool" ? `tool: ${event.name}` : `status: ${event.status}`,
        );
      return {
        content: [
          ...progress,
          result.text || "Claude Code completed without a text response.",
        ].join("\n"),
        metadata: { sessionId: result.sessionId, eventCount: result.events.length },
      };
    },
  }) as const;

export const claudeCodeToolDefinition = makeClaudeCodeTool();

export default {
  id: "t3code-claude-code",
  async setup(ctx: {
    tool?: { transform?: (fn: (draft: { add: (tool: unknown) => void }) => void) => Promise<void> };
  }) {
    if (!ctx.tool?.transform) return;
    await ctx.tool.transform((draft) => draft.add(claudeCodeToolDefinition));
  },
};
