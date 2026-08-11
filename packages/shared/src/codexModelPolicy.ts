/**
 * Codex / OpenAI GPT model pins for this product.
 *
 * Agents and defaults must not invent version strings. Only sol/luna bases;
 * capability is effort options, not a new slug. Stale ids rewrite here.
 *
 * @module shared/codexModelPolicy
 */

/** Smart / default Codex base model (OpenAI GPT-5.6 family). */
export const CODEX_MODEL_SOL = "gpt-5.6-sol";
/** Cheap / high-volume Codex base model. */
export const CODEX_MODEL_LUNA = "gpt-5.6-luna";

export const CODEX_ALLOWED_BASE_MODELS = [CODEX_MODEL_SOL, CODEX_MODEL_LUNA] as const;
export type CodexAllowedBaseModel = (typeof CODEX_ALLOWED_BASE_MODELS)[number];

const ALLOWED = new Set<string>(CODEX_ALLOWED_BASE_MODELS);

/**
 * Map retired / wrong Codex ChatGPT slugs onto the only allowed bases.
 * Effort is not encoded in the slug.
 */
const STALE_TO_BASE: ReadonlyArray<readonly [RegExp, CodexAllowedBaseModel]> = [
  // Explicit cheap / mini → luna
  [/gpt-5\.6-luna/i, CODEX_MODEL_LUNA],
  [/gpt-5\.4-mini/i, CODEX_MODEL_LUNA],
  [/gpt-5\.4-nano/i, CODEX_MODEL_LUNA],
  [/gpt-5\.5-mini/i, CODEX_MODEL_LUNA],
  [/gpt-5-mini/i, CODEX_MODEL_LUNA],
  [/gpt-5-nano/i, CODEX_MODEL_LUNA],
  [/codex-mini/i, CODEX_MODEL_LUNA],
  // Everything else in the gpt-5* / legacy codex line → sol
  [/gpt-5\.6-sol/i, CODEX_MODEL_SOL],
  [/gpt-5\.6-terra/i, CODEX_MODEL_SOL], // prior rename; still not a pin we ship
  [/gpt-5\.6/i, CODEX_MODEL_SOL],
  [/gpt-5\.5/i, CODEX_MODEL_SOL],
  [/gpt-5\.4/i, CODEX_MODEL_SOL],
  [/gpt-5\.3/i, CODEX_MODEL_SOL],
  [/gpt-5\.2/i, CODEX_MODEL_SOL],
  [/gpt-5\.1/i, CODEX_MODEL_SOL],
  [/gpt-5-codex/i, CODEX_MODEL_SOL],
  [/^gpt-5$/i, CODEX_MODEL_SOL],
  [/^5\.[0-9]/i, CODEX_MODEL_SOL],
];

function stripOpenRouterPrefix(slug: string): string {
  const trimmed = slug.trim();
  if (trimmed.startsWith("openai/")) return trimmed.slice("openai/".length);
  if (trimmed.startsWith("openrouter/openai/")) {
    return trimmed.slice("openrouter/openai/".length);
  }
  return trimmed;
}

/**
 * True when the slug is already an allowed Codex base (exact).
 */
export function isAllowedCodexBaseModel(slug: string | null | undefined): boolean {
  if (!slug) return false;
  return ALLOWED.has(stripOpenRouterPrefix(slug).trim());
}

/**
 * Resolve any proposed Codex/OpenAI model string to sol or luna.
 * Prefer `available` intersection when the live catalog/CLI list is passed.
 */
export function resolveCodexBaseModel(
  proposed: string | null | undefined,
  available?: ReadonlyArray<string> | null,
): CodexAllowedBaseModel {
  const raw = typeof proposed === "string" ? stripOpenRouterPrefix(proposed).trim() : "";
  let base: CodexAllowedBaseModel = CODEX_MODEL_SOL;

  if (raw && ALLOWED.has(raw)) {
    base = raw as CodexAllowedBaseModel;
  } else if (raw) {
    for (const [pattern, target] of STALE_TO_BASE) {
      if (pattern.test(raw)) {
        base = target;
        break;
      }
    }
    // Non-gpt strings: still default sol for codex transport; caller should not
    // pass Claude/Grok here.
  }

  if (available && available.length > 0) {
    const normalized = available.map((s) => stripOpenRouterPrefix(s).trim());
    if (normalized.includes(base)) return base;
    if (normalized.includes(CODEX_MODEL_SOL)) return CODEX_MODEL_SOL;
    if (normalized.includes(CODEX_MODEL_LUNA)) return CODEX_MODEL_LUNA;
    // Catalog has neither pin yet — still return policy default (deploy lag).
  }

  return base;
}

/** Default smart model for Codex-backed defaults in settings/contracts. */
export function defaultCodexModel(): CodexAllowedBaseModel {
  return CODEX_MODEL_SOL;
}

/** Default cheap model for text-gen / high-volume Codex paths. */
export function defaultCodexCheapModel(): CodexAllowedBaseModel {
  return CODEX_MODEL_LUNA;
}
