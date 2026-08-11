import { TextGenerationError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isTextGenerationError = Schema.is(TextGenerationError);

/** Convert an Effect Schema to a flat JSON Schema object, inlining `$defs` when present. */
export function toJsonSchemaObject(schema: Schema.Top): unknown {
  const document = Schema.toJsonSchemaDocument(schema);
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return { ...document.schema, $defs: document.definitions };
  }
  return document.schema;
}

/** Truncate a text section to `maxChars`, appending a `[truncated]` marker when needed. */
export function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars);
  return `${truncated}\n\n[truncated]`;
}

/** Normalise a raw commit subject to imperative-mood, ≤72 chars, no trailing period. */
export function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) {
    return "Update project files";
  }

  if (withoutTrailingPeriod.length <= 72) {
    return withoutTrailingPeriod;
  }
  return withoutTrailingPeriod.slice(0, 72).trimEnd();
}

/** Strip a fence that wraps the whole value, e.g. ```json … ``` */
function stripWrappingFence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const withoutOpen = trimmed.replace(/^```[a-zA-Z0-9_-]*\r?\n?/, "");
  return withoutOpen.replace(/\r?\n?```$/, "").trim();
}

/**
 * Unwrap a PR body that is itself the JSON envelope the model was asked to
 * return. Models re-emit `{"title": …, "body": …}` inside `body` often enough
 * that the raw envelope has shipped as a PR description; a reader gets an
 * escaped blob instead of the markdown that is sitting one key away.
 *
 * Bounded, and only unwraps an object that carries a string `body` — anything
 * else is left exactly as written.
 */
export function sanitizePrBody(raw: string): string {
  let value = stripWrappingFence(raw);
  for (let depth = 0; depth < 3; depth += 1) {
    if (!value.startsWith("{")) break;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      break;
    }
    if (typeof parsed !== "object" || parsed === null) break;
    const inner = (parsed as { body?: unknown }).body;
    if (typeof inner !== "string") break;
    value = stripWrappingFence(inner);
  }
  return value.trim();
}

/** Longest PR title that still reads as a subject line rather than a paragraph. */
const PR_TITLE_MAX_CHARS = 72;

/**
 * Normalise a raw PR title to a single line with a sensible fallback.
 *
 * The result goes straight into `gh pr create --title`, so a leading `-` has to
 * go: argv would read it as a flag.
 */
export function sanitizePrTitle(raw: string): string {
  const singleLine = stripWrappingFence(raw).split(/\r?\n/g)[0]?.trim().replace(/\s+/g, " ") ?? "";
  // Repeated because the wrappers nest: `## "Ship it."` needs the heading gone
  // before the quotes, and the quotes gone before the trailing period.
  let unquoted = singleLine;
  for (let pass = 0; pass < 4; pass += 1) {
    const stripped = unquoted
      .replace(/^#+\s*/, "")
      .replace(/^-+\s*/, "")
      .replace(/^['"`]+|['"`]+$/g, "")
      .replace(/[.]+$/g, "")
      .trim();
    if (stripped === unquoted) break;
    unquoted = stripped;
  }
  if (unquoted.length === 0) {
    return "Update project changes";
  }
  if (unquoted.length <= PR_TITLE_MAX_CHARS) {
    return unquoted;
  }
  return unquoted.slice(0, PR_TITLE_MAX_CHARS).trimEnd();
}

/** Normalise a raw thread title to a compact single-line sidebar-safe label. */
export function sanitizeThreadTitle(raw: string): string {
  const normalized = raw
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim()
    .replace(/\s+/g, " ");

  if (!normalized || normalized.trim().length === 0) {
    return "New thread";
  }

  if (normalized.length <= 50) {
    return normalized;
  }

  return `${normalized.slice(0, 47).trimEnd()}...`;
}

/** CLI name to human-readable label, e.g. "codex" → "Codex CLI (`codex`)" */
function cliLabel(cliName: string): string {
  const capitalized = cliName.charAt(0).toUpperCase() + cliName.slice(1);
  return `${capitalized} CLI (\`${cliName}\`)`;
}

/**
 * Normalize an unknown error from a CLI text generation process into a
 * typed `TextGenerationError`. Parameterized by CLI name so both Codex
 * and Claude (and future providers) can share the same logic.
 */
export function normalizeCliError(
  cliName: string,
  operation: string,
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (isTextGenerationError(error)) {
    return error;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      error.message.includes(`Command not found: ${cliName}`) ||
      lower.includes(`spawn ${cliName}`) ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation,
        detail: `${cliLabel(cliName)} is required but not available on PATH.`,
        cause: error,
      });
    }
    return new TextGenerationError({
      operation,
      detail: fallback,
      cause: error,
    });
  }

  return new TextGenerationError({
    operation,
    detail: fallback,
    cause: error,
  });
}
