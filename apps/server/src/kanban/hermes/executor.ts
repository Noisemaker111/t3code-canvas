/** Run one Hermes program inside Executor's WASM-backed QuickJS sandbox. */
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import * as Effect from "effect/Effect";

import type { HermesRoutingBrief } from "@t3tools/contracts";

import {
  BoardCallLimitError,
  makeBoardRecorder,
  recordVerbCalls,
  type BoardApi,
  type BoardCallRecord,
  type BoardOperationCoordinator,
} from "./boardApi.ts";
import { hermesMcpToolset, type HermesMcpToolset } from "./mcpRegistry.ts";
import { makeProgramApi, type BoardProgramApi } from "./programApi.ts";
import type { RulePolicy } from "./rulePass.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CALLS = 64;
const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_STACK_SIZE_BYTES = 1 * 1024 * 1024;

// The verb surface, not `BoardApi`: the mechanics a program used to re-derive
// live behind these, and what the rules now do on their own is off it entirely.
export const BOARD_METHODS = [
  "applyLaunchPlan",
  "structureCard",
  "advanceCard",
  "finishCard",
  "createCard",
  "updateCard",
  "archiveCard",
  "closePr",
  "nudgeThread",
  "askHelper",
  "threadTranscript",
  "answerPermission",
  "searchProjects",
  "askUser",
  "learn",
  "forget",
  "note",
  "reply",
  "readCanvas",
  "drawOnCanvas",
] as const satisfies ReadonlyArray<keyof BoardProgramApi>;

/** Verbs with mechanics of their own; the rest are recorded as primitives. */
const COMPOSITE_VERBS: ReadonlySet<string> = new Set([
  "applyLaunchPlan",
  "structureCard",
  "advanceCard",
  "finishCard",
  "askHelper",
  "askUser",
  "note",
  "reply",
]);

const BOARD_METHOD_SET = new Set<string>(BOARD_METHODS);

export type HermesExecutionResult = {
  readonly source: string;
  readonly calls: ReadonlyArray<BoardCallRecord>;
  readonly logs: ReadonlyArray<string>;
  readonly error: string | null;
  readonly recordOnly: boolean;
  /** The program's own free-text line, when it had something counters cannot say. */
  readonly note: string | null;
  /** Answers to whoever typed at Hermes, verbatim and unclipped. */
  readonly replies: ReadonlyArray<string>;
};

export type HermesExecutionInput = {
  readonly api: BoardApi;
  readonly source: string;
  readonly policy: RulePolicy;
  readonly recordOnly?: boolean;
  readonly timeoutMs?: number;
  readonly maxCalls?: number;
  readonly operations?: BoardOperationCoordinator;
  readonly routingBriefs?: ReadonlyMap<string, HermesRoutingBrief>;
  /** Connected outbound MCP servers. Defaults to what the layer has dialled. */
  readonly mcp?: HermesMcpToolset;
};

export class HermesProgramError extends Error {
  readonly phase: "compile" | "run";

  constructor(phase: "compile" | "run", message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HermesProgramError";
    this.phase = phase;
  }
}

/** Strip a ```js fence if the model wrapped the program in one. */
export function unwrapProgram(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:javascript|js|ts|typescript)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  if (fenced?.[1] !== undefined) return fenced[1].trim();
  const inline = /```(?:javascript|js|ts|typescript)?\s*\n([\s\S]*?)\n?```/.exec(trimmed);
  if (inline?.[1] !== undefined) return inline[1].trim();
  return trimmed;
}

function boardPrelude(deadline: number): string {
  const methods = BOARD_METHODS.map(
    (method) =>
      `${JSON.stringify(method)}: (input) => __callBoard(${JSON.stringify(method)}, input)`,
  ).join(",\n");
  return [
    "const __callBoard = async (method, input) => {",
    "  const response = await tools.board[method](input);",
    "  if (!response || response.ok !== true) throw new Error(response?.error || `board.${method} failed`);",
    "  return response.value;",
    "};",
    `const board = Object.freeze({${methods}});`,
    `const deadline = ${deadline};`,
  ].join("\n");
}

/** `mcp.<server>.<tool>` — the transcript key and the sandbox path, one string. */
function mcpMethodName(server: string, tool: string): string {
  return `mcp.${server}.${tool}`;
}

function mcpPrelude(toolset: HermesMcpToolset): string {
  if (toolset.servers.length === 0) return "";
  const servers = toolset.servers
    .map((server) => {
      const tools = server.tools
        .map(
          (tool) =>
            `    ${JSON.stringify(tool.name)}: (input) => __callMcp(${JSON.stringify(server.name)}, ${JSON.stringify(tool.name)}, input)`,
        )
        .join(",\n");
      return `  ${JSON.stringify(server.name)}: Object.freeze({\n${tools}\n  })`;
    })
    .join(",\n");
  return [
    "const __callMcp = async (server, tool, input) => {",
    "  const response = await tools.mcp[server][tool](input);",
    "  if (!response || response.ok !== true) throw new Error(response?.error || `mcp.${server}.${tool} failed`);",
    "  return response.value;",
    "};",
    `const mcp = Object.freeze({\n${servers}\n});`,
  ].join("\n");
}

/**
 * The MCP tools as one flat `mcp.<server>.<tool>` record, so `recordVerbCalls`
 * puts them in the same transcript, under the same call limit, as `board.*`.
 */
function makeMcpProgramApi(
  toolset: HermesMcpToolset,
): Record<string, (args: unknown) => Promise<unknown>> {
  const entries: [string, (args: unknown) => Promise<unknown>][] = [];
  for (const server of toolset.servers) {
    for (const tool of server.tools) {
      entries.push([
        mcpMethodName(server.name, tool.name),
        async (args: unknown) => (await server.call(tool.name, args)) ?? null,
      ]);
    }
  }
  return Object.fromEntries(entries);
}

function normalizeLog(line: string): string {
  return line.startsWith("[log] ") ? line.slice(6) : line;
}

export async function runHermesProgram(
  input: HermesExecutionInput,
): Promise<HermesExecutionResult> {
  const source = unwrapProgram(input.source);
  const recordOnly = input.recordOnly === true;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    // Parse only. The generated function is never invoked in the host runtime.
    new Function(`return (async () => {\n${source}\n})`);
  } catch (cause) {
    throw new HermesProgramError(
      "compile",
      cause instanceof Error ? cause.message : String(cause),
      cause,
    );
  }

  const maxCalls = input.maxCalls ?? DEFAULT_MAX_CALLS;
  const calls: BoardCallRecord[] = [];
  const notes: string[] = [];
  const replies: string[] = [];
  const recorder = makeBoardRecorder({
    api: input.api,
    recordOnly,
    maxCalls,
    calls,
    ...(input.operations ? { operations: input.operations } : {}),
  });
  // The verbs sit above the recorder, so a composite verb and the primitive
  // writes it made both land in the one transcript, in order.
  const program = recordVerbCalls({
    target: makeProgramApi({
      api: recorder.api,
      policy: input.policy,
      recordOnly,
      ...(input.routingBriefs ? { routingBriefs: input.routingBriefs } : {}),
      onNote: (text) => {
        if (text.length > 0) notes.push(text);
      },
      onReply: (text) => {
        if (text.length > 0) replies.push(text);
      },
    }) as unknown as Record<string, unknown>,
    calls,
    maxCalls,
    only: COMPOSITE_VERBS,
  });
  const toolset = input.mcp ?? hermesMcpToolset();
  // Same recorder array, same ceiling: an MCP call is a call like any other.
  const mcpTools = makeMcpProgramApi(toolset);
  const mcpProgram = recordVerbCalls({
    target: mcpTools,
    calls,
    maxCalls,
    only: new Set(Object.keys(mcpTools)),
  });
  const sandbox = makeQuickJsExecutor({
    timeoutMs,
    memoryLimitBytes: DEFAULT_MEMORY_LIMIT_BYTES,
    maxStackSizeBytes: DEFAULT_MAX_STACK_SIZE_BYTES,
  });
  const code = [boardPrelude(Date.now() + timeoutMs), mcpPrelude(toolset), source]
    .filter((part) => part.length > 0)
    .join("\n");

  let executed: { readonly logs?: ReadonlyArray<string>; readonly error?: string };
  try {
    executed = (await Effect.runPromise(
      sandbox.execute(code, {
        invoke: ({ path, args }: { path: string; args: unknown }) =>
          Effect.promise(async () => {
            const dot = path.indexOf(".");
            const namespace = dot < 0 ? "" : path.slice(0, dot);
            const method = dot < 0 ? "" : path.slice(dot + 1);
            const fn =
              namespace === "board" && BOARD_METHOD_SET.has(method)
                ? (program[method] as (value: unknown) => Promise<unknown>)
                : namespace === "mcp" && path in mcpProgram
                  ? mcpProgram[path]
                  : undefined;
            if (!fn) return { ok: false, error: `Unknown Hermes tool ${path}` };
            try {
              return { ok: true, value: (await fn(args)) ?? null };
            } catch (cause) {
              const error =
                cause instanceof BoardCallLimitError
                  ? cause.message
                  : cause instanceof Error
                    ? cause.message
                    : String(cause);
              return { ok: false, error };
            }
          }),
      }),
    )) as { readonly logs?: ReadonlyArray<string>; readonly error?: string };
  } catch (cause) {
    throw new HermesProgramError(
      "run",
      cause instanceof Error ? cause.message : String(cause),
      cause,
    );
  }

  return {
    source,
    calls: recorder.calls,
    logs: (executed.logs ?? []).map(normalizeLog),
    error: executed.error ?? null,
    recordOnly,
    note: notes.length > 0 ? notes.join(" · ").slice(0, 240) : null,
    replies,
  };
}
