/**
 * Shared prompt builders for text generation providers.
 *
 * Extracts the prompt construction logic that is identical across
 * Codex, Claude, and any future CLI-based text generation backends.
 *
 * @module textGenerationPrompts
 */
import * as Schema from "effect/Schema";
import type { ChatAttachment, PromptAssistOperation } from "@t3tools/contracts";
import { KANBAN_STRUCTURED_PROMPT_SPEC } from "@t3tools/shared/kanbanPromptFormat";

import { limitSection } from "./TextGenerationUtils.ts";

// ---------------------------------------------------------------------------
// Commit message
// ---------------------------------------------------------------------------

export interface CommitMessagePromptInput {
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  includeBranch: boolean;
  /** What the work was launched to do. Absent for an ad-hoc commit. */
  mission?: string | undefined;
}

/** The task section, or nothing when the caller has no task to name. */
function missionSection(mission: string | undefined): ReadonlyArray<string> {
  const text = mission?.trim() ?? "";
  if (text.length === 0) return [];
  return ["Task this work was launched for:", limitSection(text, 4_000), ""];
}

export function buildCommitMessagePrompt(input: CommitMessagePromptInput) {
  const wantsBranch = input.includeBranch;

  const prompt = [
    "You write concise git commit messages.",
    wantsBranch
      ? "Return a JSON object with keys: subject, body, branch."
      : "Return a JSON object with keys: subject, body.",
    "Rules:",
    "- subject must be imperative, <= 72 chars, and no trailing period",
    "- body can be empty string or short bullet points",
    ...(wantsBranch
      ? ["- branch must be a short semantic git branch fragment for this change"]
      : []),
    "- capture the primary user-visible or developer-visible change",
    ...(input.mission
      ? [
          "- describe the staged change in the words of the task below; never restate the task itself",
        ]
      : []),
    "",
    `Branch: ${input.branch ?? "(detached)"}`,
    "",
    ...missionSection(input.mission),
    "Staged files:",
    limitSection(input.stagedSummary, 6_000),
    "",
    "Staged patch:",
    limitSection(input.stagedPatch, 40_000),
  ].join("\n");

  if (wantsBranch) {
    return {
      prompt,
      outputSchema: Schema.Struct({
        subject: Schema.String,
        body: Schema.String,
        branch: Schema.String,
      }),
    };
  }

  return {
    prompt,
    outputSchema: Schema.Struct({
      subject: Schema.String,
      body: Schema.String,
    }),
  };
}

// ---------------------------------------------------------------------------
// PR content
// ---------------------------------------------------------------------------

export interface PrContentPromptInput {
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  /** What the work was launched to do. Absent for an ad-hoc pull request. */
  mission?: string | undefined;
}

export function buildPrContentPrompt(input: PrContentPromptInput) {
  const prompt = [
    "You write GitHub pull request content.",
    "Return a JSON object with keys: title, body. Return that object and nothing else.",
    "Rules:",
    "- title should be concise and specific, <= 72 chars, and no trailing period",
    "- title names the change, not the size of it: never 'multi-part', 'various' or 'assorted'",
    "- body is the markdown a reviewer reads. It is never JSON, and it never repeats this envelope",
    "- body must include the headings '## Summary' and '## Testing'",
    "- under Summary, provide short bullet points",
    "- under Testing, include bullet points with concrete checks or 'Not run' where appropriate",
    ...(input.mission
      ? ["- title names the change the task below asked for, described from the diff"]
      : []),
    "",
    `Base branch: ${input.baseBranch}`,
    `Head branch: ${input.headBranch}`,
    "",
    ...missionSection(input.mission),
    "Commits:",
    limitSection(input.commitSummary, 12_000),
    "",
    "Diff stat:",
    limitSection(input.diffSummary, 12_000),
    "",
    "Diff patch:",
    limitSection(input.diffPatch, 40_000),
  ].join("\n");

  const outputSchema = Schema.Struct({
    title: Schema.String,
    body: Schema.String,
  });

  return { prompt, outputSchema };
}

// ---------------------------------------------------------------------------
// Branch name
// ---------------------------------------------------------------------------

export interface BranchNamePromptInput {
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
}

interface PromptFromMessageInput {
  instruction: string;
  responseShape: string;
  rules: ReadonlyArray<string>;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
}

function buildPromptFromMessage(input: PromptFromMessageInput): string {
  const attachmentLines = (input.attachments ?? []).map(
    (attachment) => `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
  );

  const promptSections = [
    input.instruction,
    input.responseShape,
    "Rules:",
    ...input.rules.map((rule) => `- ${rule}`),
    "",
    "User message:",
    limitSection(input.message, 8_000),
  ];
  if (attachmentLines.length > 0) {
    promptSections.push(
      "",
      "Attachment metadata:",
      limitSection(attachmentLines.join("\n"), 4_000),
    );
  }

  return promptSections.join("\n");
}

export function buildBranchNamePrompt(input: BranchNamePromptInput) {
  const prompt = buildPromptFromMessage({
    instruction: "You generate concise git branch names.",
    responseShape: "Return a JSON object with key: branch.",
    rules: [
      "Branch should describe the requested work from the user message.",
      "Keep it short and specific (2-6 words).",
      "Use plain words only, no issue prefixes and no punctuation-heavy text.",
      "If images are attached, use them as primary context for visual/UI issues.",
    ],
    message: input.message,
    attachments: input.attachments,
  });
  const outputSchema = Schema.Struct({
    branch: Schema.String,
  });

  return { prompt, outputSchema };
}

// ---------------------------------------------------------------------------
// Thread title
// ---------------------------------------------------------------------------

export interface ThreadTitlePromptInput {
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
}

export function buildThreadTitlePrompt(input: ThreadTitlePromptInput) {
  const prompt = buildPromptFromMessage({
    instruction: "You write concise thread titles for coding conversations.",
    responseShape: "Return a JSON object with key: title.",
    rules: [
      "Title should summarize the user's request, not restate it verbatim.",
      "Keep it short and specific (3-8 words).",
      "Avoid quotes, filler, prefixes, and trailing punctuation.",
      "If images are attached, use them as primary context for visual/UI issues.",
    ],
    message: input.message,
    attachments: input.attachments,
  });
  const outputSchema = Schema.Struct({
    title: Schema.String,
  });

  return { prompt, outputSchema };
}

// ---------------------------------------------------------------------------
// Prompt assist (improve / fix spelling / to command)
// ---------------------------------------------------------------------------

export interface PromptAssistPromptInput {
  operation: PromptAssistOperation;
  text: string;
}

const PROMPT_ASSIST_INSTRUCTIONS: Record<
  PromptAssistOperation,
  { instruction: string; rules: ReadonlyArray<string> }
> = {
  improve: {
    instruction: "You rewrite coding prompts to be clearer and more actionable.",
    rules: [
      "Preserve the user's intent exactly; do not add new requirements.",
      "Make it specific, unambiguous, and well-structured.",
      "Keep it concise. Do not answer the prompt, only rewrite it.",
      "When rewriting a board/kanban card body, emit this structured template:",
      KANBAN_STRUCTURED_PROMPT_SPEC,
      "Return plain text only, no preamble, quotes, or markdown fences.",
    ],
  },
  fixSpelling: {
    instruction: "You correct spelling and grammar in the user's text.",
    rules: [
      "Fix spelling, grammar, and punctuation only.",
      "Do not reword, rephrase, translate, or change the meaning.",
      "Preserve code, identifiers, formatting, and line breaks.",
      "Return only the corrected text, with no preamble or quotes.",
    ],
  },
  command: {
    instruction: "You translate a natural-language request into a single shell command.",
    rules: [
      "Return exactly one shell command line that accomplishes the request.",
      "Prefer common POSIX tools; do not include explanations or comments.",
      "Do not wrap the command in markdown fences or quotes.",
      "If the request is ambiguous, choose the most conventional command.",
    ],
  },
  boardControl: {
    instruction:
      "You are a board-planning helper for Hermes. Structure rambles into board actions.",
    rules: [
      "Columns: prompts (capture + ready queue) → active → pr / done.",
      "Split unrelated work into SEPARATE create_prompt actions (never multi-task one card).",
      "create_prompt = ready card in prompts.",
      "Prefer create_prompt over move unless the user explicitly asks to move cards.",
      "launch_active starts a coding thread from a prompts card (one card → one thread).",
      "Never invent card ids; only update/move/delete/launch ids present in CURRENT BOARD.",
      "Respect CONVENTIONS; do not propose illegal moves (no skip to pr). Done is terminal and outside Hermes work.",
      "Return ONLY a JSON object (no markdown fences) with keys: reply (string), actions (array).",
      "Action types: create_prompt, update_prompt, move, delete, launch_active {type,id}.",
      "columns are only: prompts, active, pr, done.",
      "reply is a short user-facing summary of what you did or will do.",
    ],
  },
  skill: {
    instruction:
      "You execute a board skill. The message has skill instructions, then an INPUT section with the card text.",
    rules: [
      "Follow the skill instructions. Transform the INPUT into the skill's output.",
      "Return ONLY the final card body (the skill's output) — not the skill instructions.",
      "Do not add a preamble like 'Here is the rewritten prompt'.",
      "Preserve concrete details from INPUT; do not collapse rich rambles into one vague sentence.",
      "Do not invent requirements the user did not imply.",
      "Emit the card body as a coding brief. Project and model are card fields — never # Project / # Model lines:",
      KANBAN_STRUCTURED_PROMPT_SPEC,
      "If the skill asks for multi-thread plans, use fenced ```t3-threads only (never freeform spawn syntax).",
    ],
  },
};

export function buildPromptAssistPrompt(input: PromptAssistPromptInput) {
  const config = PROMPT_ASSIST_INSTRUCTIONS[input.operation];
  const prompt = buildPromptFromMessage({
    instruction: config.instruction,
    responseShape: "Return a JSON object with key: text.",
    rules: config.rules,
    message: input.text,
  });
  const outputSchema = Schema.Struct({
    text: Schema.String,
  });

  return { prompt, outputSchema };
}
