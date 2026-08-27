import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Prompt-assist contracts.
 *
 * A one-shot text transformation driven by the configured provider CLI (the
 * same mechanism used for commit messages and thread titles). Operations:
 *  - `improve`      – rewrite a prompt to be clearer and more actionable.
 *  - `fixSpelling`  – correct spelling/grammar only, preserving meaning.
 *  - `command`      – translate a natural-language request into a single shell
 *                     command the user can review before running.
 *  - `boardControl` – plan board actions (JSON) for the kanban controller.
 *  - `skill`        – execute a board skill instruction on the source prompt
 *                     (LLM rewrite; not string-append).
 */
export const PromptAssistOperation = Schema.Literals([
  "improve",
  "fixSpelling",
  "command",
  "boardControl",
  "skill",
]);
export type PromptAssistOperation = typeof PromptAssistOperation.Type;

/**
 * Optional model override for model-bench / one-shot experiments. When omitted
 * the server uses Settings → text generation model.
 */
export const PromptAssistModelSelection = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
});
export type PromptAssistModelSelection = typeof PromptAssistModelSelection.Type;

export const PromptAssistInput = Schema.Struct({
  operation: PromptAssistOperation,
  text: TrimmedNonEmptyString,
  /**
   * Working directory for CLI-based generation. Determines which provider
   * credentials/config are used; the server falls back to its own cwd.
   */
  cwd: Schema.optionalKey(Schema.String),
  /** Override default text-generation model for this assist call. */
  modelSelection: Schema.optionalKey(PromptAssistModelSelection),
});
export type PromptAssistInput = typeof PromptAssistInput.Type;

export const PromptAssistResult = Schema.Struct({
  operation: PromptAssistOperation,
  /** The transformed prompt, or the suggested command for `command`. */
  text: Schema.String,
});
export type PromptAssistResult = typeof PromptAssistResult.Type;
