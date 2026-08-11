/**
 * Friction the agent never reported.
 *
 * An agent that hits a broken tool and quietly routes around it is behaving
 * well and still loses the observation, so self-reporting cannot be the only
 * producer. This watches the projected thread activities for failures and files
 * the papercut on the first sighting, without anyone cooperating — repeats of
 * one signature collapse into that entry's count.
 *
 * The pure detector is separated from the sweep so it is testable without a
 * database.
 *
 * @module friction/detector
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { normalizeSignature, type FrictionInput } from "./frictionStore.ts";

/** One projected activity row, narrowed to what detection needs. */
export interface FrictionActivityRow {
  readonly threadId: string;
  readonly kind: string;
  readonly tone: string | null;
  readonly summary: string | null;
  readonly detail: string | null;
  readonly createdAt: string;
  /**
   * `failed` on a `tool.updated` row. Adapters set this from the harness's own
   * error flag, so it is exact where {@link FAILURE_TEXT} is a guess.
   */
  readonly status?: string | null;
  /** Canonical item type; `command_execution` is the one with a command. */
  readonly itemType?: string | null;
  /** The shell command the agent ran, when the payload carried one. */
  readonly command?: string | null;
}

/**
 * One failure is enough. Waiting for repeats scales backwards — the better the
 * agent, the faster it routes around a broken tool and the fewer repeats it
 * leaves — and the store dedups by fingerprint, so the first sighting costs one
 * entry, not noise.
 */
export const DETECT_MIN_REPEATS = 1;

/**
 * A completed tool call that reads like a failure. Harnesses report a broken
 * `apply_patch` as a *completed* tool whose text carries the error, so the
 * error-toned activities alone would miss the case this exists for.
 */
const FAILURE_TEXT =
  /\b(failed|failure|error|not found|no such|denied|refused|cannot|can't|unable|unsupported|timed out)\b/i;
const MISSING_MANDATED_SKILL =
  /repository-mandated\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s+skill\s+is\s+not\s+installed/i;

function toolName(row: FrictionActivityRow): string {
  if (row.kind === "tool.denied") {
    const match = /^Tool denied:\s*(.+)$/.exec(row.summary ?? "");
    if (match?.[1]) return match[1].trim();
  }
  if (row.kind === "runtime.error") return "runtime";
  const summary = (row.summary ?? "").trim();
  if (!summary) return "unknown";
  // Titles arrive as "apply_patch" or "Edit file …" — the first token is the
  // tool, the rest is the target and would splinter the fingerprint.
  return (summary.split(/\s+/)[0] ?? summary).replace(/[:,]$/, "");
}

function isFailure(row: FrictionActivityRow): boolean {
  if (row.status === "failed") return true;
  if (row.tone === "error") return true;
  if (row.kind !== "tool.completed") return false;
  return FAILURE_TEXT.test(`${row.summary ?? ""} ${row.detail ?? ""}`);
}

function signatureOf(row: FrictionActivityRow): string {
  return `${row.summary ?? ""} ${row.detail ?? ""}`.trim();
}

function missingMandatedSkillOf(row: FrictionActivityRow): string | null {
  return MISSING_MANDATED_SKILL.exec(signatureOf(row))?.[1]?.toLowerCase() ?? null;
}

/**
 * Group failures by (thread, tool, normalized signature) and emit one papercut
 * per group that repeated enough. The emitted `evidence` is the raw text of the
 * first sighting, so the fingerprint the store computes matches what a
 * self-reported papercut for the same failure would produce.
 */
export function detectFriction(
  rows: ReadonlyArray<FrictionActivityRow>,
  options: { readonly minRepeats?: number } = {},
): ReadonlyArray<FrictionInput> {
  const minRepeats = options.minRepeats ?? DETECT_MIN_REPEATS;
  const groups = new Map<
    string,
    { row: FrictionActivityRow; tool: string; count: number; lastAt: string }
  >();
  for (const row of rows) {
    if (!isFailure(row)) continue;
    // Shell commands belong to detectWorkarounds alone. This pass has no bar
    // beyond "exited non-zero", which for a command means every `grep` that
    // matched nothing and every `cat` of a file that was not there — and it
    // labelled them with the first word of the activity title, so they landed
    // as tools named `Command` and `Ran`. Worse, a command that *was* worked
    // around got filed twice: once here as `Command`, once there under its real
    // family, same failure, two fingerprints. detectWorkarounds requires a
    // successful substitute before it reports, which is the evidence that
    // separates friction from a search with no hits.
    if (commandRunOf(row) !== null) continue;
    const signature = signatureOf(row);
    if (!signature) continue;
    const missingSkill = missingMandatedSkillOf(row);
    const tool = missingSkill ? "repository-mandated-skills" : toolName(row);
    const key = missingSkill
      ? `${row.threadId}|${tool}|${missingSkill}`
      : `${row.threadId}|${tool}|${normalizeSignature(signature)}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastAt = row.createdAt;
      continue;
    }
    groups.set(key, { row, tool, count: 1, lastAt: row.createdAt });
  }
  return [...groups.values()]
    .filter((group) => group.count >= minRepeats)
    .map((group) => ({
      source: "detector" as const,
      scope: "harness" as const,
      tool: group.tool,
      summary: missingMandatedSkillOf(group.row)
        ? `Repository-mandated skill '${missingMandatedSkillOf(group.row)}' is missing`
        : `${group.tool} failed ${group.count}x in one thread`,
      evidence: signatureOf(group.row),
      workaround: null,
      threadId: group.row.threadId,
      context: { detectedRepeats: String(group.count) },
      at: group.lastAt,
    }));
}

/** Prefixes an agent bolts on that are not the command it means to run. */
const CD_PREFIX = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/;
const ENV_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/;
const TIMEOUT_PREFIX = /^timeout\s+\S+\s+/;

/**
 * The tool an agent thinks it is running, with the directory and flags it
 * happened to use stripped off — `vp lint` for both `cd vendor/t3code && vp
 * lint` and `vp lint --report-unused-disable-directives`. Two invocations that
 * share a family are two attempts at one job, which is what makes the second
 * one a workaround for the first.
 */
export function commandFamily(command: string): string {
  let rest = command.trim();
  for (;;) {
    const next = rest.replace(CD_PREFIX, "").replace(ENV_PREFIX, "").replace(TIMEOUT_PREFIX, "");
    if (next === rest) break;
    rest = next;
  }
  const family: Array<string> = [];
  for (const token of rest.split(/\s+/)) {
    if (family.length >= 3 || token.startsWith("-") || token.length === 0) break;
    family.push(token);
  }
  return family.join(" ").toLowerCase();
}

interface CommandRun {
  readonly row: FrictionActivityRow;
  readonly command: string;
  readonly family: string;
  readonly key: string;
}

function commandRunOf(row: FrictionActivityRow): CommandRun | null {
  const command = (row.command ?? "").trim();
  if (!command) return null;
  if (row.itemType && row.itemType !== "command_execution") return null;
  const family = commandFamily(command);
  if (!family) return null;
  return { row, command, family, key: normalizeSignature(command) };
}

/**
 * The workaround a capable agent used, attached as evidence.
 *
 * A good agent fails once, substitutes something that works, and finishes the
 * task. That substitution is itself the evidence: a command that failed, never
 * succeeded as written, and was replaced by a *different* command doing the
 * same job that did succeed — the papercut ships with the fix the next agent
 * should be handed.
 *
 * Requiring the substitute is what keeps this quiet. A one-off `grep` that
 * matches nothing exits non-zero and is never retried, but nothing in its
 * family succeeds afterwards either, so it is not friction and not reported.
 */
export function detectWorkarounds(
  rows: ReadonlyArray<FrictionActivityRow>,
): ReadonlyArray<FrictionInput> {
  const byThread = new Map<string, Array<CommandRun>>();
  for (const row of rows) {
    const run = commandRunOf(row);
    if (!run) continue;
    const list = byThread.get(row.threadId);
    if (list) list.push(run);
    else byThread.set(row.threadId, [run]);
  }

  const found: Array<FrictionInput> = [];
  for (const runs of byThread.values()) {
    const ordered = [...runs].sort((a, b) => a.row.createdAt.localeCompare(b.row.createdAt));
    const succeededKeys = new Set(
      ordered.filter((run) => !isFailure(run.row)).map((run) => run.key),
    );
    const emitted = new Set<string>();

    for (const [index, run] of ordered.entries()) {
      if (!isFailure(run.row)) continue;
      // Retried verbatim and it worked: a blip, not a papercut.
      if (succeededKeys.has(run.key)) continue;
      if (emitted.has(run.key)) continue;
      const substitute = ordered
        .slice(index + 1)
        .find(
          (later) => later.family === run.family && later.key !== run.key && !isFailure(later.row),
        );
      if (!substitute) continue;
      emitted.add(run.key);
      found.push({
        source: "detector",
        scope: "harness",
        tool: run.family,
        summary: `${run.family} failed and was worked around`,
        evidence: signatureOf(run.row) || run.command,
        workaround: substitute.command,
        threadId: run.row.threadId,
        context: { failedCommand: run.command, workedCommand: substitute.command },
        at: run.row.createdAt,
      });
    }
  }
  return found;
}

/**
 * How far the last sweep got. Without it every sweep re-reports the same
 * activities and the count inflates until everything looks chronic.
 */
let watermarkPath: string | null = null;

export function bindFrictionSweep(baseDir: string): string {
  const dir = NodePath.join(baseDir, "friction");
  try {
    NodeFS.mkdirSync(dir, { recursive: true });
    watermarkPath = NodePath.join(dir, "sweep.json");
  } catch {
    watermarkPath = null;
  }
  return watermarkPath ?? "";
}

export function readSweepWatermark(): string | null {
  if (!watermarkPath) return null;
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(watermarkPath, "utf8")) as {
      at?: unknown;
    };
    return typeof parsed.at === "string" ? parsed.at : null;
  } catch {
    return null;
  }
}

export function writeSweepWatermark(at: string): void {
  if (!watermarkPath) return;
  try {
    NodeFS.writeFileSync(watermarkPath, JSON.stringify({ at }), "utf8");
  } catch {
    // A watermark that cannot be written costs a duplicate sweep, not data.
  }
}
