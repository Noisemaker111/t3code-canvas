/**
 * Canonical structured body for kanban draft/prompt cards.
 *
 * Project and model live on the card fields (`projectId`, `modelSelection`) —
 * never as required body headers. Body is the agent brief (+ optional Goal/Size).
 *
 * Optional legacy headers (still parsed if present):
 *   # Goal: …
 *   # Project: … (id=…)   ← prefer card.projectId
 *   # Model: … / …        ← prefer card.modelSelection
 *   # Size: small|medium|large
 */

export type KanbanPromptSize = "small" | "medium" | "large";

export type KanbanStructuredPrompt = {
  readonly goal: string;
  readonly projectLabel: string | null;
  readonly projectId: string | null;
  readonly modelLabel: string | null;
  readonly modelInstanceId: string | null;
  readonly modelSlug: string | null;
  readonly size: KanbanPromptSize | null;
  readonly description: string;
};

const GOAL_RE = /^#\s*Goal:\s*(.+)$/im;
const PROJECT_RE = /^#\s*Project:\s*(.+)$/im;
const MODEL_RE = /^#\s*Model:\s*(.+)$/im;
const SIZE_RE = /^#\s*Size:\s*(small|medium|large)\s*$/im;
const PROJECT_ID_IN_LABEL_RE = /\(id=([^)]+)\)\s*$/i;

export function normalizeKanbanPromptSize(raw: string | null | undefined): KanbanPromptSize | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "small" || v === "medium" || v === "large") return v;
  return null;
}

function parseProjectLabel(raw: string): { label: string; projectId: string | null } {
  const trimmed = raw.trim();
  const idMatch = trimmed.match(PROJECT_ID_IN_LABEL_RE);
  if (idMatch?.[1]) {
    return {
      label: trimmed.replace(PROJECT_ID_IN_LABEL_RE, "").trim() || trimmed,
      projectId: idMatch[1].trim(),
    };
  }
  return { label: trimmed, projectId: null };
}

function parseModelLabel(raw: string): {
  label: string;
  instanceId: string | null;
  model: string | null;
} {
  const trimmed = raw.trim();
  const slash = trimmed.split("/").map((part) => part.trim());
  if (slash.length >= 2 && slash[0] && slash[1]) {
    return {
      label: trimmed,
      instanceId: slash[0],
      model: slash.slice(1).join("/"),
    };
  }
  return { label: trimmed, instanceId: null, model: null };
}

export function parseKanbanStructuredPrompt(body: string): KanbanStructuredPrompt {
  const text = body.replace(/\r\n/g, "\n").trim();
  const goal = text.match(GOAL_RE)?.[1]?.trim() ?? "";
  const projectRaw = text.match(PROJECT_RE)?.[1]?.trim() ?? null;
  const modelRaw = text.match(MODEL_RE)?.[1]?.trim() ?? null;
  const size = normalizeKanbanPromptSize(text.match(SIZE_RE)?.[1]);
  const project = projectRaw ? parseProjectLabel(projectRaw) : null;
  const model = modelRaw ? parseModelLabel(modelRaw) : null;

  const withoutHeaders = text
    .split("\n")
    .filter((line) => !/^\s*#\s*(Goal|Project|Model|Size)\s*:/i.test(line))
    .join("\n")
    .trim();

  return {
    goal: goal || withoutHeaders.split("\n")[0]?.trim() || text.slice(0, 120),
    projectLabel: project?.label ?? null,
    projectId: project?.projectId ?? null,
    modelLabel: model?.label ?? null,
    modelInstanceId: model?.instanceId ?? null,
    modelSlug: model?.model ?? null,
    size,
    description: withoutHeaders,
  };
}

export function formatKanbanStructuredPrompt(input: {
  goal: string;
  projectLabel?: string | null;
  projectId?: string | null;
  modelInstanceId?: string | null;
  modelSlug?: string | null;
  size?: KanbanPromptSize | null;
  description?: string | null;
}): string {
  const goal = input.goal.trim() || "Untitled task";
  const projectParts: string[] = [];
  if (input.projectLabel?.trim()) projectParts.push(input.projectLabel.trim());
  if (input.projectId?.trim()) {
    const id = input.projectId.trim();
    if (!projectParts.some((part) => part.includes(id))) {
      projectParts.push(projectParts.length === 0 ? id : `(id=${id})`);
    } else if (input.projectLabel?.trim() && !/\(id=/.test(input.projectLabel)) {
      projectParts[0] = `${input.projectLabel.trim()} (id=${id})`;
      projectParts.length = 1;
    }
  }
  const projectLine =
    projectParts.length === 0
      ? null
      : projectParts.length === 1
        ? projectParts[0]
        : `${projectParts[0]} (id=${input.projectId!.trim()})`;

  const modelLine =
    input.modelInstanceId?.trim() && input.modelSlug?.trim()
      ? `${input.modelInstanceId.trim()} / ${input.modelSlug.trim()}`
      : input.modelSlug?.trim() || input.modelInstanceId?.trim() || null;

  const size = input.size ?? null;
  const description = (input.description ?? "").trim();

  const lines = [`# Goal: ${goal}`];
  if (projectLine) lines.push(`# Project: ${projectLine}`);
  if (modelLine) lines.push(`# Model: ${modelLine}`);
  if (size) lines.push(`# Size: ${size}`);
  if (description.length > 0) {
    lines.push("");
    lines.push(description);
  }
  return lines.join("\n");
}

/** First non-empty line suitable as a card title. */
export function kanbanPromptTitleFromBody(body: string): string {
  const parsed = parseKanbanStructuredPrompt(body);
  const goal = parsed.goal.replace(/^#\s*Goal:\s*/i, "").trim();
  return goal.slice(0, 120) || "Untitled task";
}

export const KANBAN_STRUCTURED_PROMPT_SPEC = [
  "Card body is the coding brief only (Mission / Work / Constraints / Done when).",
  "Optional headers allowed in the body:",
  "# Goal: <one-line outcome>",
  "# Size: small | medium | large",
  "",
  "<short description / acceptance criteria>",
  "",
  "Rules:",
  "- One coding task per card.",
  "- Do NOT write # Project or # Model in the body. Those are card fields set by tools/UI (projectId, modelSelection).",
  "- Never invent placeholders like '(unspecified — no project named)' or '(unspecified — no model named)'.",
  "- Legacy # Size may be preserved for display, but never drives model or effort selection.",
  "- Do not invent session init / workspace health-check fluff.",
].join("\n");

/** Remove Project/Model body headers — fields are authoritative. */
export function stripKanbanProjectModelHeaders(body: string): string {
  return body
    .split("\n")
    .filter(
      (line) => !/^#\s*Project:\s*/i.test(line.trim()) && !/^#\s*Model:\s*/i.test(line.trim()),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
