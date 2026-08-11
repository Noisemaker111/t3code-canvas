/**
 * Multi-thread spawn blocks for board prompts.
 *
 * Only content inside a fenced ```t3-threads ... ``` block is parsed.
 * Freeform conversation text never accidentally spawns threads.
 */

export type ThreadBlock = {
  readonly index: number;
  readonly title: string;
  /** Optional model slug / label from the block header. */
  readonly model: string | null;
  readonly prompt: string;
};

const FENCE_RE = /```t3-threads\s*\n([\s\S]*?)```/gi;

/**
 * Parse all ```t3-threads``` fences from a card body.
 * Returns [] when none — caller should treat the whole body as a single thread.
 */
export function parseThreadBlocks(raw: string): ReadonlyArray<ThreadBlock> {
  const text = raw.trim();
  if (text.length === 0) return [];

  const chunks: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(FENCE_RE.source, FENCE_RE.flags);
  while ((match = re.exec(text)) !== null) {
    const body = match[1]?.trim();
    if (body) chunks.push(body);
  }
  if (chunks.length === 0) return [];

  const blocks: ThreadBlock[] = [];
  for (const chunk of chunks) {
    blocks.push(...parseThreadChunk(chunk, blocks.length));
  }
  return blocks.filter((b) => b.prompt.trim().length > 0);
}

/**
 * One fence body → thread entries.
 *
 * Supported headers (case-insensitive):
 *   ### Thread 1 — model-slug
 *   ### Thread 1: title | model: slug
 *   ## Thread 2
 *   - Thread 1 (model: slug)
 */
function parseThreadChunk(chunk: string, startIndex: number): ThreadBlock[] {
  const lines = chunk.split(/\r?\n/);
  const headerRe = /^(?:#{1,3}\s*)?(?:[-*]\s*)?thread\s*(\d+)?\s*(?:[:—\-–]\s*(.+))?$/i;

  type Acc = { title: string; model: string | null; lines: string[] };
  const entries: Acc[] = [];
  let current: Acc | null = null;

  const flush = () => {
    if (!current) return;
    const prompt = current.lines.join("\n").trim();
    if (prompt.length > 0 || current.title) {
      entries.push(current);
    }
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const hm = headerRe.exec(trimmed);
    if (hm) {
      flush();
      const rest = (hm[2] ?? "").trim();
      const { title, model } = splitTitleModel(rest);
      current = {
        title: title || `Thread ${entries.length + 1 + startIndex}`,
        model,
        lines: [],
      };
      continue;
    }
    if (!current) {
      // Content before first header → implicit Thread 1
      current = {
        title: `Thread ${entries.length + 1 + startIndex}`,
        model: null,
        lines: [line],
      };
      continue;
    }
    current.lines.push(line);
  }
  flush();

  return entries.map((entry, i) => ({
    index: startIndex + i + 1,
    title: entry.title.slice(0, 120),
    model: entry.model,
    prompt: entry.lines.join("\n").trim(),
  }));
}

function splitTitleModel(rest: string): { title: string; model: string | null } {
  if (!rest) return { title: "", model: null };
  // "title | model: slug" or "model: slug" or "slug only when looks like model id"
  const modelPipe = /\|\s*model\s*:\s*(.+)$/i.exec(rest);
  if (modelPipe) {
    return {
      title: rest.slice(0, modelPipe.index).trim(),
      model: modelPipe[1]!.trim() || null,
    };
  }
  const modelInline = /^model\s*:\s*(.+)$/i.exec(rest);
  if (modelInline) {
    return { title: "", model: modelInline[1]!.trim() || null };
  }
  // "Claude Sonnet 4" or "openrouter/anthropic/..." after em-dash already in rest
  if (/[\/@]/.test(rest) || /^(claude|gpt|o\d|gemini|grok|openrouter)/i.test(rest)) {
    return { title: "", model: rest };
  }
  return { title: rest, model: null };
}

/** Single-thread fallback when no fence exists. */
export function threadsForLaunch(cardBody: string, cardTitle: string): ReadonlyArray<ThreadBlock> {
  const parsed = parseThreadBlocks(cardBody);
  if (parsed.length > 0) return parsed;
  const prompt = cardBody.trim() || cardTitle.trim();
  if (!prompt) return [];
  return [
    {
      index: 1,
      title: cardTitle.trim().slice(0, 120) || "Thread 1",
      model: null,
      prompt,
    },
  ];
}
