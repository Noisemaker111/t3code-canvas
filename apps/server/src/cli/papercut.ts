/**
 * `t3 papercut` — record a broken tool from the shell, and read the log back.
 *
 * The shell-side twin of the `kanban_papercut` MCP tool: same store, same
 * dedup, so a papercut you file by hand and one an agent files land in one
 * counted entry. Writes only; the escalation to a fix card is Hermes's.
 *
 * @module cli/papercut
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument, Command, Flag } from "effect/unstable/cli";

import {
  bindFrictionLog,
  listFriction,
  recordFriction,
  restoreFrictionLog,
  type FrictionScope,
} from "../friction/frictionStore.ts";

const DEFAULT_BASE_DIR = "/var/lib/t3j";

const SCOPES: ReadonlyArray<FrictionScope> = ["harness", "repo", "env", "upstream"];

function parseScope(value: string | undefined): FrictionScope {
  if (value === undefined) return "harness";
  const scope = SCOPES.find((candidate) => candidate === value);
  if (!scope) throw new Error(`Unknown scope "${value}". One of: ${SCOPES.join(", ")}.`);
  return scope;
}

export const runPapercut = (options: {
  readonly summary: string | undefined;
  readonly tool: string | undefined;
  readonly evidence: string | undefined;
  readonly workaround: string | undefined;
  readonly scope: string | undefined;
  readonly list: boolean;
  readonly baseDir: string | undefined;
}) =>
  Effect.gen(function* () {
    const baseDir = options.baseDir ?? process.env["T3CODE_BASE_DIR"] ?? DEFAULT_BASE_DIR;
    bindFrictionLog(baseDir);
    restoreFrictionLog();

    if (options.list) {
      const entries = listFriction();
      if (entries.length === 0) {
        yield* Console.log("No papercuts recorded.");
        return;
      }
      for (const entry of entries) {
        const threads = entry.threadIds.length;
        yield* Console.log(
          `${String(entry.count).padStart(3)}x  ${entry.status.padEnd(7)} ${entry.scope}/${entry.tool}  ${entry.summary}` +
            (threads > 1 ? `  (${threads} threads)` : "") +
            (entry.fixCardId ? `  → card ${entry.fixCardId}` : ""),
        );
      }
      return;
    }

    if (options.summary === undefined) {
      yield* Console.error("Nothing to record. Pass a summary, or --list to read the log.");
      return;
    }

    const entry = recordFriction({
      source: "agent",
      scope: parseScope(options.scope),
      tool: options.tool ?? "unknown",
      summary: options.summary,
      // With no --evidence the summary is the only signature there is, so
      // fingerprinting falls back to it rather than collapsing every hand-filed
      // papercut into one entry.
      evidence: options.evidence ?? options.summary,
      workaround: options.workaround ?? null,
    });
    yield* Console.log(
      `Recorded ${entry.fingerprint} (${entry.count}x, ${entry.status}) — ${entry.summary}`,
    );
  });

export const papercutCommand = Command.make("papercut", {
  summary: Argument.string("summary").pipe(
    Argument.withDescription("One sentence: what broke."),
    Argument.optional,
  ),
  tool: Flag.string("tool").pipe(
    Flag.withDescription("The tool, command or binary that broke, e.g. apply_patch."),
    Flag.optional,
  ),
  evidence: Flag.string("evidence").pipe(
    Flag.withDescription("The error text itself. Defaults to the summary."),
    Flag.optional,
  ),
  workaround: Flag.string("workaround").pipe(
    Flag.withDescription("What you did instead — what unblocks the next agent."),
    Flag.optional,
  ),
  scope: Flag.string("scope").pipe(
    Flag.withDescription(`Where the fix lands: ${SCOPES.join(" | ")}. Defaults to harness.`),
    Flag.optional,
  ),
  list: Flag.boolean("list").pipe(
    Flag.withDescription("Print the recorded papercuts instead of adding one."),
    Flag.withDefault(false),
  ),
  baseDir: Flag.string("base-dir").pipe(
    Flag.withDescription(
      "Base directory holding friction/ (defaults to $T3CODE_BASE_DIR, else /var/lib/t3j).",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Record a broken tool or command you had to work around, so the board can act on it.",
  ),
  Command.withHandler((flags) =>
    runPapercut({
      summary: Option.getOrUndefined(flags.summary),
      tool: Option.getOrUndefined(flags.tool),
      evidence: Option.getOrUndefined(flags.evidence),
      workaround: Option.getOrUndefined(flags.workaround),
      scope: Option.getOrUndefined(flags.scope),
      list: flags.list,
      baseDir: Option.getOrUndefined(flags.baseDir),
    }),
  ),
);
