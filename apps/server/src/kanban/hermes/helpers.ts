/**
 * Helper threads — the loop's way of asking a question without answering it
 * itself.
 *
 * Hermes has exactly one lever for delegation today: launch a card into Active.
 * That costs a card, a column, a worktree and an eventual PR, so every question
 * too big for one tick — is this thread actually done, what does this repo call
 * its test command, which project does this composer text belong to — was
 * answered inside the tick, in Hermes's own context, by Hermes's own model. The
 * loop is single-locked, so that time is time the board is not answering.
 *
 * A helper is the missing primitive: an ephemeral agent thread with no card, no
 * column and no git, asked one bounded question and read on a later tick. The
 * tick that asks does not wait. Two things make it pay:
 *
 * - The runtime moves the bytes, not the model. A helper pointed at a thread
 *   gets that thread's transcript attached to *its* prompt; Hermes pays no
 *   tokens to read it.
 * - A card with a helper out is off the judgment queue until the answer lands,
 *   so the loop goes cheap instead of re-deciding the same card every minute.
 *
 * @module kanban/hermes/helpers
 */
import type { BoardApi } from "./boardApi.ts";
import { settleHermesHelper, type HermesHelper, type HermesHelperStatus } from "./helperStore.ts";

/**
 * A freshly created thread reports `turnState: "none"` for a moment. Settling
 * it in that window would file "no answer" against a helper that has not been
 * asked yet.
 */
const MIN_SETTLE_MS = 20_000;

const ANSWER_MAX_CHARS = 4000;
const PROMPT_ANSWER_CHARS = 1500;
const PROMPT_QUESTION_CHARS = 200;

/** Transcript entries handed to a helper that was pointed at a thread. */
export const HELPER_TRANSCRIPT_LIMIT = 40;

const HELPER_CONTRACT = [
  "---",
  "",
  "## You are a helper thread",
  "",
  "The board brain asked you one question and is not waiting on this conversation —",
  "it reads your last message on a later beat. So answer the question that was asked",
  "and stop.",
  "",
  "Read whatever you need: the repository, the files, anything quoted above.",
  "Do not change files, do not branch, commit, push or open a pull request, and do",
  "not touch the board. You have no git and no card; work that changes code is a",
  "different thread's job.",
  "",
  "End with the answer itself as your final message — plain prose, whatever length",
  "the answer needs. The board reads that message and nothing else, so it has to",
  "carry the whole answer, not a pointer to one. If you cannot answer, say what you",
  "looked at and what is missing; that is a real answer and the board can act on it.",
].join("\n");

export function buildHelperPrompt(input: {
  readonly question: string;
  readonly transcript?: string | null;
}): string {
  const parts = [input.question.trim()];
  if (input.transcript && input.transcript.trim().length > 0) {
    parts.push(
      [
        "## Transcript of the thread this is about",
        "",
        "Quoted for you so the board did not have to read it. Newest last.",
        "",
        input.transcript.trim(),
      ].join("\n"),
    );
  }
  parts.push(HELPER_CONTRACT);
  return `${parts.join("\n\n")}\n`;
}

/** The tail a helper is handed, flattened. Never enters a Hermes prompt. */
export function formatHelperTranscript(
  entries: ReadonlyArray<{ readonly role: string; readonly text: string }>,
): string {
  return entries.map((entry) => `${entry.role}: ${entry.text}`).join("\n\n");
}

export type HelperCollection = {
  readonly settled: ReadonlyArray<{
    readonly id: string;
    readonly status: Exclude<HermesHelperStatus, "running">;
    readonly answer: string;
  }>;
  readonly logs: ReadonlyArray<string>;
};

function ageMs(helper: HermesHelper, nowMs: number): number {
  const parsed = Date.parse(helper.askedAt);
  return Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : 0;
}

/**
 * Poll every running helper and settle the ones that stopped. Deterministic and
 * modelless: it belongs in the rules pass, and its board calls land in the same
 * tick transcript as every other write.
 */
export async function collectHermesHelpers(input: {
  readonly api: BoardApi;
  readonly helpers: ReadonlyArray<HermesHelper>;
  readonly timeoutMs: number;
  readonly now?: () => number;
}): Promise<HelperCollection> {
  const nowMs = (input.now ?? (() => Date.now()))();
  const settled: Array<{
    id: string;
    status: Exclude<HermesHelperStatus, "running">;
    answer: string;
  }> = [];
  const logs: string[] = [];

  for (const helper of input.helpers) {
    if (helper.status !== "running") continue;
    const transcript = await input.api
      .threadTranscript({ threadId: helper.threadId, limit: 8 })
      .catch(() => null);
    const age = ageMs(helper, nowMs);

    const settle = async (status: Exclude<HermesHelperStatus, "running">, answer: string) => {
      settleHermesHelper({
        id: helper.id,
        status,
        answer: answer.slice(0, ANSWER_MAX_CHARS),
        settledAt: new Date(nowMs).toISOString(),
      });
      settled.push({ id: helper.id, status, answer });
      logs.push(
        `helper ${helper.id}: ${status === "answered" ? "answered" : `failed — ${answer}`}`,
      );
      // The thread has said everything it is going to. Archiving it keeps the
      // sidebar the human's and lets the reaper take the worktree back.
      await input.api.archiveThread({ threadId: helper.threadId }).catch(() => undefined);
    };

    if (transcript === null || !transcript.exists) {
      await settle("failed", "the helper thread is gone");
      continue;
    }
    if (
      transcript.turnState === "running" ||
      (transcript.turnState === "none" && age < MIN_SETTLE_MS)
    ) {
      if (age >= input.timeoutMs) {
        await settle("failed", `still running after ${Math.round(age / 60_000)}m — abandoned`);
      }
      continue;
    }

    const answer = [...transcript.entries]
      .reverse()
      .find((entry) => entry.role === "assistant" && entry.text.trim().length > 0);
    if (!answer) {
      await settle("failed", `stopped (turn=${transcript.turnState}) without answering`);
      continue;
    }
    await settle("answered", answer.text.trim());
  }

  return { settled, logs };
}

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/**
 * The `## HELPERS` block. A running helper is here to stop the model asking the
 * same question twice; an answered one is here to be acted on.
 */
export function formatHelperBlock(
  helpers: ReadonlyArray<HermesHelper>,
  nowMs = Date.now(),
): string | null {
  const live = helpers.filter((helper) => helper.status === "running" || !helper.delivered);
  if (live.length === 0) return null;
  const lines = live.map((helper) => {
    const where = helper.cardId ? `card=${helper.cardId}` : "(no card)";
    const question = JSON.stringify(
      clip(helper.question.replace(/\s+/g, " "), PROMPT_QUESTION_CHARS),
    );
    if (helper.status === "running") {
      const waited = Math.round(ageMs(helper, nowMs) / 60_000);
      return `- ${helper.id} [running ${waited}m] ${where} asked ${question}`;
    }
    const label = helper.status === "answered" ? "ANSWERED" : "FAILED";
    const body = clip((helper.answer ?? "").trim(), PROMPT_ANSWER_CHARS)
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    return `- ${helper.id} [${label}] ${where} asked ${question}\n${body}`;
  });
  // A [running] line is why its card is not in the queue; [ANSWERED] is the
  // answer in full, once. Both are stated in the cached prefix, not here.
  return lines.join("\n");
}
