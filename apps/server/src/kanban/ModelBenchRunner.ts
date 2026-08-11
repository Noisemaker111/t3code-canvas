/**
 * Model bench: stream OpenRouter chat for real TTFT, completion time, tokens, cost.
 */
import {
  estimateUsdCost,
  getOpenRouterCatalog,
  openRouterIdFromSlug,
  type OpenRouterCatalogEntry,
} from "./OpenRouterModelCatalog.ts";
import { countTokens } from "../textGeneration/tokenizer/TokenCounter.ts";
import { resolveProviderKey } from "../usage/UsageService.ts";

export type ModelBenchRole = "hermes" | "structure";

export type ModelBenchCandidate = {
  readonly instanceId: string;
  readonly model: string;
  readonly label?: string;
};

export type IntelligenceDimensions = {
  /** 0–25: correct capture of user intent / no invented requirements */
  readonly fidelity: number;
  /** 0–25: prioritization / tradeoffs / what matters first */
  readonly reasoning: number;
  /** 0–25: concrete next work a coding agent can do */
  readonly actionability: number;
  /** 0–25: completeness for the role (plan coverage or brief coverage) */
  readonly completeness: number;
};

export type ModelBenchTrialResult = {
  readonly role: ModelBenchRole;
  readonly instanceId: string;
  readonly model: string;
  readonly label: string;
  readonly openRouterId: string | null;
  readonly ok: boolean;
  /** Headers → first content token (model stream latency; not provider queue). */
  readonly ttftMs: number | null;
  /** Request start → response headers (network + provider queue). */
  readonly headersMs?: number | null;
  /** Request start → stream end (queue + full generation). */
  readonly completionMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  /** Actual cost when usage tokens + catalog prices available. */
  readonly costUsd: number | null;
  readonly costSource: "usage+list_price" | "estimated_tokens+list_price" | "unknown";
  readonly tokensSource: "openrouter_usage" | "tiktoken" | "none";
  /** Format/structure heuristic only (JSON shape, headings). */
  readonly structureScore: number;
  /**
   * LLM-judge intelligence 0–100 (sum of rubric dimensions). Null if judge failed
   * or was skipped. This is the column that answers “how smart is this output?”
   */
  readonly intelligenceScore: number | null;
  readonly intelligence: IntelligenceDimensions | null;
  /** One-line judge note; persisted with the trial. */
  readonly intelligenceNote: string | null;
  readonly judgeModel: string | null;
  /** @deprecated Use structureScore; kept for older UI reads. */
  readonly qualityScore: number;
  readonly outputPreview: string;
  readonly error?: string;
  readonly ranAt: string;
};

/** Default OpenRouter judge — cheap, consistent, good enough for rubric scoring. */
export const DEFAULT_BENCH_JUDGE_MODEL = "x-ai/grok-4.5";

const HERMES_PROMPT = [
  "You are Hermes, the board control agent. Rewrite this into a tight coding-agent brief.",
  "Output markdown with: Mission, Work to do, Constraints, Done when. Keep concrete detail. No fluff.",
  "Input:",
  "promo: make the settings page load faster on phone, maybe lazy load panels, don't break desktop",
].join("\n");

/** Voice-note ramble used for structure skill bench (same as board Apply skills). */
export const STRUCTURE_BENCH_RAMBLE = [
  "ok so uh yeah this is a voice note from like the car, so the login button on mobile is all squished,",
  "like the text is wrapping under the icon and on my pixel it looks broken, desktop is fine though,",
  "don't mess with desktop. also the settings page takes forever on phone, i think because we load every",
  "panel at once, maybe lazy load those sections? and there's this toast that never goes away after you",
  "save a profile change, you have to refresh the whole app, that's super annoying. i'd rather we fix the",
  "toast first if we can only do one thing, then the login button, settings is nice to have. oh and when",
  "you open settings from the sidebar on a small screen the back chevron is tiny and hard to hit. yeah",
  "that's it i think, don't redesign the whole settings UI just make it not suck on phone.",
].join(" ");

const STRUCTURE_SKILL_INSTRUCTIONS = [
  "You turn messy human input into a board card: card summary + full coding brief.",
  "",
  "REQUIRED output shape:",
  "1) Line 1 = CARD SUMMARY — exactly one plain-English sentence (≤160 chars) for the kanban card title.",
  "   NOT the word Mission, not a section heading. Name the work + priority if given.",
  "   Example: Fix sticky profile-save toast first, then mobile login wrap, then lazy-load settings on phone without touching desktop.",
  "2) Blank line.",
  "3) Full brief with sections as needed:",
  "   Mission / Why it matters (optional) / Work to do / Constraints / Done when / Open questions",
  "",
  "Keep EVERY concrete detail in the full brief. Do not invent requirements.",
  "The summary is only a card label — the brief must still be complete.",
  "If several independent missions: summary line, blank line, then ```t3-threads with full thread bodies.",
].join("\n");

const STRUCTURE_PROMPT = [
  STRUCTURE_SKILL_INSTRUCTIONS,
  "",
  "---",
  "INPUT:",
  "",
  STRUCTURE_BENCH_RAMBLE,
].join("\n");

export function promptForRole(role: ModelBenchRole): string {
  if (role === "structure") return STRUCTURE_PROMPT;
  return HERMES_PROMPT;
}

/** Format/structure only — not intelligence. */
export function scoreBenchOutput(role: ModelBenchRole, text: string): number {
  const t = text.trim();
  if (!t) return 0;
  let score = 20;
  if (t.length > 40) score += 10;
  if (t.length > 120 && t.length < 6_000) score += 10;
  if (role === "structure") {
    const firstLine = t.split(/\n/)[0]?.trim() ?? "";
    // Card summary line present and not a section header
    if (
      firstLine.length >= 24 &&
      firstLine.length <= 180 &&
      !/^(mission|work to do|constraints|done when|why it matters)\b/i.test(firstLine)
    ) {
      score += 15;
    }
    if (/mission|work to do|done when|constraints/i.test(t)) score += 15;
    if (/toast|login|settings|mobile|lazy/i.test(t)) score += 15;
    if (/don.?t (mess|break|redesign)|desktop/i.test(t)) score += 10;
    if (/```t3-threads/i.test(t)) score += 10;
    if (t.length < 200) score -= 15;
    if (t.split(/\n/).length >= 5) score += 10;
  } else {
    if (/mission|intent|scope|done when|work to do/i.test(t)) score += 25;
    if (/constraint|don.?t|acceptance/i.test(t)) score += 15;
    if (t.split(/\s+/).length >= 40) score += 10;
  }
  return Math.max(0, Math.min(100, score));
}

function clampDim(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(25, Math.round(v)));
}

function judgePrompt(role: ModelBenchRole, task: string, output: string): string {
  if (role === "structure") {
    return [
      "You grade AI outputs for a board STRUCTURE skill.",
      "Task was: turn a messy voice-note ramble into (1) a one-sentence card summary on line 1, then (2) a full coding-agent mission brief.",
      "Score intelligence and usefulness — not markdown decoration.",
      "",
      "Return ONLY JSON:",
      '{"fidelity":0-25,"reasoning":0-25,"actionability":0-25,"completeness":0-25,"note":"one sentence"}',
      "",
      "Rubric:",
      "- fidelity: keeps toast / login squish / settings slowness / chevron / priorities / don't break desktop",
      "- reasoning: toast-first priority if they said so; sensible lazy-load without redesign",
      "- actionability: line 1 is a usable card summary sentence (not the word Mission); brief is executable",
      "- completeness: summary + mission + work + constraints + done-when (or t3-threads); NOT hollow skeleton",
      "",
      "Penalize: starting with Mission heading only; collapsing to one vague sentence with no brief; inventing features.",
      "",
      "TASK:",
      task.slice(0, 2000),
      "",
      "OUTPUT:",
      output.slice(0, 3500),
    ].join("\n");
  }
  return [
    "You grade AI outputs for Hermes, a board control agent that writes coding briefs.",
    "Task was: rewrite a promo into a mission-style coding brief.",
    "Score intelligence and usefulness, not markdown formatting.",
    "",
    "Return ONLY JSON:",
    '{"fidelity":0-25,"reasoning":0-25,"actionability":0-25,"completeness":0-25,"note":"one sentence"}',
    "",
    "Rubric:",
    "- fidelity: correct intent; no gold-plating or invented features",
    "- reasoning: sensible approach (e.g. lazy-load without breaking desktop)",
    "- actionability: concrete engineering steps a coder can start",
    "- completeness: mission + constraints + verifiable done criteria",
    "",
    "TASK:",
    task,
    "",
    "OUTPUT:",
    output.slice(0, 3500),
  ].join("\n");
}

async function judgeIntelligence(input: {
  key: string;
  role: ModelBenchRole;
  task: string;
  output: string;
  judgeModel: string;
  fetchImpl?: typeof fetch;
}): Promise<{
  intelligenceScore: number;
  intelligence: IntelligenceDimensions;
  intelligenceNote: string;
  judgeModel: string;
} | null> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  try {
    const response = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "HTTP-Referer": "https://code.noisemakerjon.com",
        "X-Title": "T3J model bench judge",
      },
      body: JSON.stringify({
        model: input.judgeModel,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: judgePrompt(input.role, input.task, input.output),
          },
        ],
      }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content?.trim() ?? "";
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
    const intelligence: IntelligenceDimensions = {
      fidelity: clampDim(parsed.fidelity),
      reasoning: clampDim(parsed.reasoning),
      actionability: clampDim(parsed.actionability),
      completeness: clampDim(parsed.completeness),
    };
    const intelligenceScore =
      intelligence.fidelity +
      intelligence.reasoning +
      intelligence.actionability +
      intelligence.completeness;
    const note =
      typeof parsed.note === "string" && parsed.note.trim()
        ? parsed.note.trim().slice(0, 240)
        : null;
    return {
      intelligenceScore,
      intelligence,
      intelligenceNote: note ?? "Judge scored without a note.",
      judgeModel: input.judgeModel,
    };
  } catch {
    return null;
  }
}

function emptyIntelFields(): Pick<
  ModelBenchTrialResult,
  | "structureScore"
  | "intelligenceScore"
  | "intelligence"
  | "intelligenceNote"
  | "judgeModel"
  | "qualityScore"
> {
  return {
    structureScore: 0,
    intelligenceScore: null,
    intelligence: null,
    intelligenceNote: null,
    judgeModel: null,
    qualityScore: 0,
  };
}

type StreamResult = {
  text: string;
  /**
   * Time from response headers → first non-empty content delta.
   * Excludes connection / provider queue wait before the stream opens, so
   * sequential role runs do not fake a slower “Hermes TTFT”.
   */
  ttftMs: number | null;
  /** Time from request start → response headers (queue + network). */
  headersMs: number | null;
  completionMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  generationId: string | null;
};

function deltaContent(choice: unknown): string | null {
  if (!choice || typeof choice !== "object") return null;
  const c = choice as {
    delta?: {
      content?: string | Array<{ type?: string; text?: string }>;
      text?: string;
    };
    text?: string;
  };
  const delta = c.delta;
  if (delta) {
    if (typeof delta.content === "string" && delta.content.length > 0) return delta.content;
    // Some providers send content as an array of parts.
    if (Array.isArray(delta.content)) {
      const joined = delta.content
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("");
      if (joined.length > 0) return joined;
    }
    if (typeof delta.text === "string" && delta.text.length > 0) return delta.text;
  }
  // Rare non-stream-shaped chunk
  if (typeof c.text === "string" && c.text.length > 0) return c.text;
  return null;
}

async function streamOpenRouterChat(input: {
  key: string;
  modelId: string;
  prompt: string;
  fetchImpl?: typeof fetch;
}): Promise<StreamResult> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const requestStarted = Date.now();
  let headersAt: number | null = null;
  let ttftMs: number | null = null;
  let text = "";
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let generationId: string | null = null;

  const response = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.key}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "HTTP-Referer": "https://code.noisemakerjon.com",
      "X-Title": "T3J model bench",
    },
    body: JSON.stringify({
      model: input.modelId,
      messages: [{ role: "user", content: input.prompt }],
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  headersAt = Date.now();

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenRouter ${response.status}: ${body.slice(0, 200)}`);
  }
  if (!response.body) {
    throw new Error("OpenRouter response had no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof parsed.id === "string" && !generationId) generationId = parsed.id;
      const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
      for (const choice of choices) {
        const content = deltaContent(choice);
        if (content !== null) {
          // TTFT = first token after stream opens (not request start).
          if (ttftMs === null) ttftMs = Date.now() - (headersAt ?? requestStarted);
          text += content;
        }
      }
      const usage =
        parsed.usage && typeof parsed.usage === "object"
          ? (parsed.usage as Record<string, unknown>)
          : null;
      if (usage) {
        if (typeof usage.prompt_tokens === "number") promptTokens = usage.prompt_tokens;
        if (typeof usage.completion_tokens === "number") completionTokens = usage.completion_tokens;
      }
    }
  }

  return {
    text,
    ttftMs,
    headersMs: headersAt === null ? null : headersAt - requestStarted,
    // Full wall time still measured from request start (queue + generate).
    completionMs: Date.now() - requestStarted,
    promptTokens,
    completionTokens,
    generationId,
  };
}

type GeneratedTrial = {
  readonly trial: ModelBenchTrialResult;
  readonly fullText: string;
};

async function generateModelBenchTrial(input: {
  role: ModelBenchRole;
  candidate: ModelBenchCandidate;
  catalogById: Map<string, OpenRouterCatalogEntry>;
  openRouterKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<GeneratedTrial> {
  const label = input.candidate.label?.trim() || input.candidate.model;
  const ranAt = new Date().toISOString();
  const openRouterId = openRouterIdFromSlug(input.candidate.model);
  const prompt = promptForRole(input.role);
  const entry = openRouterId ? (input.catalogById.get(openRouterId) ?? null) : null;

  if (!openRouterId || !input.openRouterKey) {
    return {
      fullText: "",
      trial: {
        role: input.role,
        instanceId: input.candidate.instanceId,
        model: input.candidate.model,
        label,
        openRouterId,
        ok: false,
        ttftMs: null,
        headersMs: null,
        completionMs: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: null,
        costSource: "unknown",
        tokensSource: "none",
        ...emptyIntelFields(),
        outputPreview: "",
        error: !openRouterId
          ? "Only OpenRouter-routed models support actual token/cost/TTFT streaming bench."
          : "OpenRouter API key not found (OPENROUTER_API_KEY or OpenCode auth.json).",
        ranAt,
      },
    };
  }

  try {
    const stream = await streamOpenRouterChat({
      key: input.openRouterKey,
      modelId: openRouterId,
      prompt,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });

    let promptTokens = stream.promptTokens;
    let completionTokens = stream.completionTokens;
    let tokensSource: ModelBenchTrialResult["tokensSource"] = "openrouter_usage";
    if (promptTokens === null || completionTokens === null) {
      promptTokens = countTokens(prompt);
      completionTokens = countTokens(stream.text);
      tokensSource = "tiktoken";
    }

    const costUsd = estimateUsdCost({
      promptTokens,
      completionTokens,
      entry,
    });

    const structureScore = scoreBenchOutput(input.role, stream.text);

    return {
      fullText: stream.text,
      trial: {
        role: input.role,
        instanceId: input.candidate.instanceId,
        model: input.candidate.model,
        label,
        openRouterId,
        ok: true,
        ttftMs: stream.ttftMs,
        headersMs: stream.headersMs,
        completionMs: stream.completionMs,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        costUsd,
        costSource:
          tokensSource === "openrouter_usage" && costUsd !== null
            ? "usage+list_price"
            : costUsd !== null
              ? "estimated_tokens+list_price"
              : "unknown",
        tokensSource,
        structureScore,
        qualityScore: structureScore,
        intelligenceScore: null,
        intelligence: null,
        intelligenceNote: null,
        judgeModel: null,
        outputPreview: stream.text.slice(0, 320),
        ranAt,
      },
    };
  } catch (cause) {
    return {
      fullText: "",
      trial: {
        role: input.role,
        instanceId: input.candidate.instanceId,
        model: input.candidate.model,
        label,
        openRouterId,
        ok: false,
        ttftMs: null,
        headersMs: null,
        completionMs: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: null,
        costSource: "unknown",
        tokensSource: "none",
        ...emptyIntelFields(),
        outputPreview: "",
        error: cause instanceof Error ? cause.message : String(cause),
        ranAt,
      },
    };
  }
}

async function attachJudgeToTrial(
  generated: GeneratedTrial,
  input: {
    openRouterKey: string;
    fetchImpl?: typeof fetch;
  },
): Promise<ModelBenchTrialResult> {
  const { trial, fullText } = generated;
  if (!trial.ok || !fullText.trim()) return trial;
  const judgeModel = stringEnv("T3CODE_MODEL_BENCH_JUDGE") ?? DEFAULT_BENCH_JUDGE_MODEL;
  const judged = await judgeIntelligence({
    key: input.openRouterKey,
    role: trial.role,
    task: promptForRole(trial.role),
    output: fullText,
    judgeModel,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  if (!judged) return { ...trial, judgeModel };
  return {
    ...trial,
    intelligenceScore: judged.intelligenceScore,
    intelligence: judged.intelligence,
    intelligenceNote: judged.intelligenceNote,
    judgeModel: judged.judgeModel,
  };
}

function stringEnv(name: string): string | null {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : null;
}

export async function runModelBenchBatch(input: {
  candidates: ReadonlyArray<ModelBenchCandidate>;
  /**
   * Default: structure (ramble → mission). Hermes brief is optional.
   */
  roles?: ReadonlyArray<ModelBenchRole>;
  onProgress?: (message: string) => void;
}): Promise<ReadonlyArray<ModelBenchTrialResult>> {
  const roles = input.roles ?? (["structure"] as const);
  const catalog = await getOpenRouterCatalog();
  const key = await resolveProviderKey("openrouter");
  const results: ModelBenchTrialResult[] = [];
  let step = 0;
  // Per candidate: parallel role streams, then parallel judges.
  const total = input.candidates.length * 2;

  for (const candidate of input.candidates) {
    step += 1;
    input.onProgress?.(
      `${step}/${total} · generate · ${roles.join("+")} · ${candidate.label ?? candidate.model}`,
    );

    // Fair TTFT: all requested roles stream at the same time (no judge queue in between).
    const generated = await Promise.all(
      roles.map((role) =>
        generateModelBenchTrial({
          role,
          candidate,
          catalogById: catalog.byId,
          ...(key ? { openRouterKey: key } : {}),
        }),
      ),
    );

    step += 1;
    input.onProgress?.(
      `${step}/${total} · judge · ${roles.join("+")} · ${candidate.label ?? candidate.model}`,
    );

    if (!key) {
      results.push(...generated.map((g) => g.trial));
      continue;
    }

    const judged = await Promise.all(
      generated.map((g) => attachJudgeToTrial(g, { openRouterKey: key })),
    );
    results.push(...judged);
  }
  return results;
}
