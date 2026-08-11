/**
 * The fixed block appended to every Active launch prompt.
 *
 * **Written to the agent as a colleague, not as a subsystem.** A thread is
 * doing a task for someone; that it is doing it inside a kanban loop is not its
 * business, and every sentence spent explaining the loop is a sentence about
 * something the agent cannot act on. So: no "the board", no rule names, no
 * account of what happens to the closing note after it is written. Rules in the
 * imperative, first person for whoever is asking.
 *
 * Length is the other half. This block ships on every launch and dwarfed the
 * task on a short card, so each line has to earn its place — an instruction the
 * agent must follow, or a tool it must call. Justifications were argued at a
 * model once and then billed forever; the instruction survives, the argument
 * does not.
 *
 * What it still asks for is the closing note's *content*: what changed, what is
 * left, and a question asked as a question. Those are the branches the loop
 * takes on its own (`continue-active`, and the `asking` fall-through to the
 * model), and none of them needs naming here to work — the classifier reads
 * what the agent wrote, not whether it was told to write it.
 *
 * No report format is required, and none should be added: rigid
 * DONE/REMAINING templates break in long contexts and derail the loop.
 *
 * @module kanban/hermes/agentContract
 */
import type { BoardModelRosterEntry } from "@t3tools/contracts";

import type { Lesson } from "./knowledgeStore.ts";
import { formatLaunchLessons } from "./lessons.ts";

const CONTRACT_HEADING = "## How we work";

/**
 * Headings this block has shipped under. `withAgentContract` appends once, and
 * a thread launched before a rename must not collect a second copy.
 */
const CONTRACT_HEADINGS = [
  CONTRACT_HEADING,
  "## Working with the board",
  "## Reporting contract (the board reads this)",
] as const;

export const AGENT_REPORT_CONTRACT = [
  "---",
  "",
  CONTRACT_HEADING,
  "",
  "Don't branch, commit, push, or open a pull request — that is handled for you.",
  "Leave your work in the worktree.",
  "",
  "Before you change code, find this repo's own test, typecheck and format commands",
  "— `package.json` scripts first, then `CLAUDE.md` / `AGENTS.md` / `README.md` — and",
  "use those. Don't substitute a tool you happen to know.",
  "",
  "If a tool or command is broken and you work around it, call `kanban_papercut`",
  "right then: what broke, the error, what you did instead.",
  "",
  "When you stop, end with a short note: what you changed, what is left, and anything",
  "you need me to decide. Ask that as one question, with the options you see. Asking",
  "is fine — don't guess an architectural call to avoid it. No format required; keep",
  "the narration out of it.",
].join("\n");

const RULES_HEADING = "## Model rules";

/**
 * The owner's own sentence per model, verbatim. A thread that delegates or
 * switches models needs the same rules Hermes routed by, or the two disagree.
 */
export function formatModelRulesBlock(
  roster: ReadonlyArray<BoardModelRosterEntry> | undefined,
): string | null {
  const rules = (roster ?? []).filter((entry) => entry.note.trim().length > 0);
  if (rules.length === 0) return null;
  return [
    RULES_HEADING,
    "",
    "What the owner uses each model for, in preference order:",
    "",
    ...rules.map((entry) => {
      const options = (entry.options ?? [])
        .map((option) => `${option.id}=${String(option.value)}`)
        .join(" ");
      return `- ${entry.instanceId}/${entry.model}${options ? ` [${options}]` : ""} — ${entry.note.trim()}`;
    }),
  ].join("\n");
}

/**
 * Append the contract (model rules and learned lessons with it) once;
 * re-launches must not stack it.
 *
 * The lessons block is the point of the whole knowledge store: a fact the box
 * already paid to discover is stated up front instead of being corrected out of
 * the agent one nudge at a time. It is bounded and it is facts only — nothing
 * about where they came from, which the agent cannot act on.
 */
export function withAgentContract(
  prompt: string,
  roster?: ReadonlyArray<BoardModelRosterEntry>,
  lessons?: ReadonlyArray<Lesson>,
): string {
  if (CONTRACT_HEADINGS.some((heading) => prompt.includes(heading))) return prompt;
  const tail = [
    AGENT_REPORT_CONTRACT,
    formatLaunchLessons(lessons ?? []),
    formatModelRulesBlock(roster),
  ]
    .filter((block): block is string => block !== null)
    .join("\n\n");
  return `${prompt.trimEnd()}\n\n${tail}\n`;
}
