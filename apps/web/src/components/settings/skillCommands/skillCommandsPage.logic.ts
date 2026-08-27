import type { UnifiedSettings } from "@t3tools/contracts";

export const MAX_SKILL_COMMAND_ID_LENGTH = 64;
export const MAX_SKILL_COMMAND_PROMPT_LENGTH = 20_000;
const SKILL_COMMAND_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * Names already claimed by built-in composer slash commands
 * (`ComposerSlashCommand` in composer-logic.ts). A skill with one of these
 * names would never fire — the built-in handler runs first — so registration
 * is blocked outright rather than silently shadowed.
 */
export const RESERVED_SKILL_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "model",
  "plan",
  "default",
  "btw",
]);

/** Trim + lowercase + validate a user-typed skill name against the slug rule. */
export function normalizeSkillCommandId(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_SKILL_COMMAND_ID_LENGTH ||
    !SKILL_COMMAND_ID_PATTERN.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

export function isReservedSkillCommandName(id: string): boolean {
  return RESERVED_SKILL_COMMAND_NAMES.has(id.toLowerCase());
}

/** Whole-map replace, matching `ServerSettingsPatch.skillCommands`'s contract. */
export function buildSkillCommandsPatch(
  next: UnifiedSettings["skillCommands"],
): Partial<UnifiedSettings> {
  return { skillCommands: next };
}

/**
 * Build the LLM message for a skill run: skill instructions + input body.
 * No template placeholders — the model always receives both parts.
 * Legacy `{{prompt}}` tokens in stored skills are stripped if present.
 */
export function buildSkillLlmMessage(skillPrompt: string, sourcePrompt: string): string {
  const skill = skillPrompt
    .replaceAll("{{prompt}}", "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const source = sourcePrompt.trim();
  if (skill.length === 0) return source;
  if (source.length === 0) return skill;
  return `${skill}\n\n---\nINPUT:\n\n${source}`;
}

export type StarterGlobalSkill = {
  readonly id: string;
  readonly prompt: string;
  readonly description: string;
};

/**
 * Browser skills are optional prompt transforms. Routing is never a browser
 * skill: Hermes invokes understand-task, resolve-project, select-execution and
 * place-work on the server. Keep retired ids out of legacy always-on settings.
 */
export const CORE_BOARD_SKILL_IDS = [] as const;
const RETIRED_BOARD_SKILL_IDS: ReadonlySet<string> = new Set(["model-router"]);
export type CoreBoardSkillId = (typeof CORE_BOARD_SKILL_IDS)[number];

export function isCoreBoardSkillId(id: string): id is CoreBoardSkillId {
  return (CORE_BOARD_SKILL_IDS as ReadonlyArray<string>).includes(id);
}

/** Core skills first (fixed order), then optional ids (deduped, order preserved). */
export function mergeCoreBoardSkillIds(ids: ReadonlyArray<string> | null | undefined): string[] {
  const extras: string[] = [];
  const seen = new Set<string>([...CORE_BOARD_SKILL_IDS, ...RETIRED_BOARD_SKILL_IDS]);
  if (Array.isArray(ids)) {
    for (const id of ids) {
      if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      extras.push(id);
    }
  }
  return [...CORE_BOARD_SKILL_IDS, ...extras];
}

/**
 * Default board skills. Each is plain instruction text sent to the model with
 * the card body appended as INPUT. Worded for real agent handoff — preserve
 * detail, avoid hollow template shells that collapse a ramble into one sentence.
 */
export const STARTER_GLOBAL_SKILLS: ReadonlyArray<StarterGlobalSkill> = [
  {
    id: "structure",
    description: "Voice ramble → card summary line + full coding mission",
    prompt: `You turn messy human input (voice notes, stream-of-consciousness) into a board card a coding agent can run.

## Output shape (required)

Line 1 — CARD SUMMARY (exactly one sentence, ≤160 chars):
- Plain English headline for the kanban card title/preview.
- Must NOT be the word "Mission", a section label, or a heading.
- Name the main work + priority if they gave one (e.g. toast first, then login, then settings).
- Example: "Fix sticky profile-save toast first, then mobile login button wrap, then lazy-load settings on phone without touching desktop."

Then a blank line, then the FULL brief (agent body — detail lives here, not in the summary):

Mission
What success looks like (as many sentences as needed; keep concrete detail).

Why it matters
Optional. Only if they gave motivation or urgency.

Work to do
Bullets, priority order if they implied one.

Constraints
Don't-break / platforms / out of scope.

Done when
Verifiable checks.

Open questions
Only real ambiguities; omit section if none.

## Rules
- Keep EVERY concrete detail in the full brief (UI spots, Pixel, priorities, don't redesign settings, desktop untouched).
- Do not invent requirements.
- The card summary is a label only — never replace the brief with just that sentence.
- Direct agent voice in the brief.

## Several independent missions
If work should run as separate coding threads, still start with one card summary sentence, blank line, then ONLY a fenced block:

\`\`\`t3-threads
### Thread 1
<full mission brief>

### Thread 2
<full mission brief>
\`\`\``,
  },
  {
    id: "research",
    description: "Harden a mission with approach, risks, and repo-aware notes",
    prompt: `You strengthen an existing coding mission before someone implements it.

Return ONE improved agent prompt (not a research essay). Preserve every requirement and constraint from the input.

In the improved brief, weave in only what helps implementation:
- Likely pitfalls or trade-offs for this kind of change (short)
- A recommended approach and why (one path, not a catalog of options)
- What "good" looks like if success criteria were fuzzy
- If the input names a product/area, stay specific — do not genericize

Do not strip UI detail, priorities, or "don't break X". Do not invent repo paths unless you are certain they exist from the input itself.`,
  },
  {
    id: "classify",
    description: "Tag type/difficulty without destroying the mission",
    prompt: `Classify the work, then keep the full mission intact.

Return exactly:

---
Type: <tiny-ui-fix | small-ux-fix | feature | difficult-feature | architectural-rewrite | research-spike | docs | chore>
Difficulty: <1-5>
Risk: <low | medium | high>
Suggested model: <cheap | mid-tier | strong>
Why: <one short sentence>
---

Then paste the FULL original mission/prompt unchanged below the meta block. Do not rewrite, shorten, or restructure the body.`,
  },
  {
    id: "implement",
    description: "Optional: expand mission into a longer implementation brief",
    prompt: `Expand the input into an implementation brief a coding agent can follow end-to-end.
Optional skill — prefer a tight structure mission when the brief is already enough.

Preserve the mission and all constraints. Keep any leading meta / # Size / Recommended block if present. Add only operational detail:

Mission
(restated clearly, no detail lost)

Plan
Ordered steps to implement (concrete, not ceremony).

Touch points
Likely areas of the codebase or product surfaces — only if inferable; mark guesses as guesses.

Branch / PR
New branch, focused commits, draft PR when ready, description should match mission.

Acceptance
How to verify done (manual + automated if relevant).

Do not change
Explicit out-of-scope and things that must keep working.

Return the brief only — no preamble.`,
  },
  {
    id: "scope-batch",
    description: "Focus one primary mission; park the rest as deferred",
    prompt: `This card should drive ONE coding thread. If the input packs multiple missions, pick the primary (most urgent or first they stressed) and fully write that mission. Put the rest under Deferred — do not drop them, but do not expand them into full parallel prompts here (use structure + t3-threads for true parallel work).

Return:

Mission
Full primary mission with all of its details, constraints, and done-when.

Deferred
Bullets of other work mentioned, enough that nothing is lost.

Do not invent scope. Do not shrink the primary into a one-liner.`,
  },
];

/** Core starters only (for ensure/seed). */
export function getCoreBoardStarterSkills(): ReadonlyArray<StarterGlobalSkill> {
  return STARTER_GLOBAL_SKILLS.filter((skill) => isCoreBoardSkillId(skill.id));
}

export type SkillsShImportRef = {
  readonly owner: string;
  readonly repo: string;
  readonly skill: string;
};

/**
 * Parse a skills.sh / GitHub-style skill reference into owner/repo/skill.
 * Accepts:
 * - owner/repo/skill
 * - owner/repo@skill  (CLI form)
 * - https://skills.sh/owner/repo/skill
 * - npx skills add owner/repo --skill name
 * - npx skills add owner/repo@skill
 */
export function parseSkillsShRef(raw: string): SkillsShImportRef | null {
  const text = raw.trim();
  if (text.length === 0) return null;

  const atForm =
    /(?:npx\s+skills\s+add\s+)?(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)@([A-Za-z0-9_-]+)/i.exec(
      text,
    );
  if (atForm) {
    return {
      owner: atForm[1]!,
      repo: atForm[2]!,
      skill: atForm[3]!.toLowerCase(),
    };
  }

  const npxMatch =
    /npx\s+skills\s+add\s+(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?(?:\s+--skill\s+([A-Za-z0-9_-]+))?/i.exec(
      text,
    );
  if (npxMatch?.[3]) {
    return {
      owner: npxMatch[1]!,
      repo: npxMatch[2]!,
      skill: npxMatch[3]!.toLowerCase(),
    };
  }

  const skillsShMatch =
    /(?:https?:\/\/(?:www\.)?skills\.sh\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_-]+)\/?/i.exec(
      text,
    );
  if (skillsShMatch) {
    return {
      owner: skillsShMatch[1]!,
      repo: skillsShMatch[2]!,
      skill: skillsShMatch[3]!.toLowerCase(),
    };
  }

  const simple = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_-]+)$/.exec(text);
  if (simple) {
    return { owner: simple[1]!, repo: simple[2]!, skill: simple[3]!.toLowerCase() };
  }

  return null;
}

export type SkillsShSearchHit = {
  readonly id: string;
  readonly skillId: string;
  readonly name: string;
  readonly installs: number;
  readonly source: string;
  readonly owner: string;
  readonly repo: string;
};

type SkillsShSearchApiResponse = {
  readonly skills?: ReadonlyArray<{
    readonly id?: string;
    readonly skillId?: string;
    readonly name?: string;
    readonly installs?: number;
    readonly source?: string;
  }>;
};

function formatFetchFailure(cause: unknown, context: string): Error {
  if (cause instanceof TypeError) {
    return new Error(
      `${context} blocked (network/CORS). The app proxies via /api/skills-sh — is the T3 server running and reachable?`,
    );
  }
  if (cause instanceof Error) return cause;
  return new Error(String(cause));
}

/** Search skills.sh by keyword / natural language (same index as `npx skills find`). */
export async function searchSkillsSh(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReadonlyArray<SkillsShSearchHit>> {
  const q = query.trim();
  if (q.length === 0) return [];

  // Browser → T3 server proxy (avoids skills.sh CORS from Vite/local origins).
  const url = `/api/skills-sh/search?q=${encodeURIComponent(q)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch (cause) {
    throw formatFetchFailure(cause, "skills.sh search");
  }
  if (!response.ok) {
    throw new Error(
      `skills.sh search failed (${response.status}). Ensure you're signed in and the server can reach the internet.`,
    );
  }
  const data = (await response.json()) as SkillsShSearchApiResponse;
  const hits: SkillsShSearchHit[] = [];
  for (const skill of data.skills ?? []) {
    const source = skill.source?.trim() ?? "";
    const skillId = (skill.skillId ?? skill.name ?? "").trim();
    if (!source.includes("/") || skillId.length === 0) continue;
    const [owner, repo] = source.split("/");
    if (!owner || !repo) continue;
    hits.push({
      id: skill.id ?? `${source}/${skillId}`,
      skillId,
      name: skill.name ?? skillId,
      installs: typeof skill.installs === "number" ? skill.installs : 0,
      source,
      owner,
      repo,
    });
  }
  return hits;
}

/**
 * Resolve an import field: exact refs import immediately; otherwise search
 * skills.sh and return hits (or auto-import when the field is already exact).
 */
export function isNaturalLanguageSkillQuery(raw: string): boolean {
  return parseSkillsShRef(raw) === null && raw.trim().length > 0;
}

/** Candidate raw GitHub URLs for a skill's SKILL.md. */
export function skillsShSkillMdUrls(ref: SkillsShImportRef): ReadonlyArray<string> {
  const { owner, repo, skill } = ref;
  const bases = ["main", "master"];
  const paths = [
    `skills/${skill}/SKILL.md`,
    `${skill}/SKILL.md`,
    `.agents/skills/${skill}/SKILL.md`,
    `.claude/skills/${skill}/SKILL.md`,
    `packages/${skill}/SKILL.md`,
  ];
  const urls: string[] = [];
  for (const branch of bases) {
    for (const path of paths) {
      urls.push(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`);
    }
  }
  return urls;
}

export type ParsedSkillMarkdown = {
  readonly id: string | null;
  readonly prompt: string;
};

/** Strip YAML frontmatter and derive a skill slug from name if present. */
export function parseSkillMarkdown(markdown: string, fallbackId: string): ParsedSkillMarkdown {
  let body = markdown.replace(/^\uFEFF/, "");
  let id: string | null = null;

  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end !== -1) {
      const front = body.slice(3, end);
      body = body.slice(end + 4).replace(/^\r?\n/, "");
      const nameMatch = /^name:\s*["']?([A-Za-z0-9_-]+)["']?\s*$/m.exec(front);
      if (nameMatch) {
        id = normalizeSkillCommandId(nameMatch[1]!);
      }
    }
  }

  const prompt = body.trim();
  return {
    id: id ?? normalizeSkillCommandId(fallbackId),
    prompt,
  };
}

export async function fetchSkillMarkdownFromSkillsSh(
  raw: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; prompt: string; source: string }> {
  const ref = parseSkillsShRef(raw);
  if (!ref) {
    throw new Error("Use owner/repo/skill or a skills.sh URL (e.g. mattpocock/skills/research).");
  }

  let lastError: string | null = null;
  for (const url of skillsShSkillMdUrls(ref)) {
    try {
      // Proxy through T3 server so the browser never hits GitHub/skills.sh CORS.
      const proxyUrl = `/api/skills-sh/fetch?url=${encodeURIComponent(url)}`;
      const response = await fetchImpl(proxyUrl, {
        headers: { Accept: "text/plain" },
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) {
        lastError = `${response.status} ${url}`;
        continue;
      }
      const text = await response.text();
      if (!text.trim() || text.trim().startsWith("404") || text.trim().startsWith("Host not")) {
        lastError = `empty ${url}`;
        continue;
      }
      const parsed = parseSkillMarkdown(text, ref.skill);
      if (!parsed.id || !parsed.prompt) {
        throw new Error("Fetched SKILL.md but could not parse a name or body.");
      }
      if (parsed.prompt.length > MAX_SKILL_COMMAND_PROMPT_LENGTH) {
        throw new Error(`Skill is longer than ${MAX_SKILL_COMMAND_PROMPT_LENGTH} characters.`);
      }
      return { id: parsed.id, prompt: parsed.prompt, source: url };
    } catch (error) {
      lastError =
        error instanceof TypeError
          ? formatFetchFailure(error, "Skill import").message
          : error instanceof Error
            ? error.message
            : String(error);
    }
  }

  throw new Error(
    lastError ? `Could not load SKILL.md (${lastError}).` : "Could not load SKILL.md from GitHub.",
  );
}
