/**
 * Cheap keyword fishing from a Prompt onto board projects so Hermes can pick
 * a project without reading huge READMEs. Hermes still decides; this only
 * ranks obvious name/path hits (e.g. "kanban" → the one project that owns it).
 */

export type ProjectKeywordTarget = {
  readonly id: string;
  readonly name: string;
  readonly slug?: string | null;
  readonly workspaceRoot?: string | null;
  readonly repo?: string | null;
};

export type ProjectKeywordHit = {
  readonly projectId: string;
  readonly name: string;
  readonly slug: string;
  readonly score: number;
  /** Tokens from the prompt that matched this project identity. */
  readonly matched: ReadonlyArray<string>;
};

const STOP = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "from",
  "this",
  "that",
  "it",
  "is",
  "are",
  "be",
  "as",
  "at",
  "by",
  "we",
  "you",
  "our",
  "need",
  "needs",
  "fix",
  "add",
  "make",
  "please",
  "should",
  "would",
  "could",
  "when",
  "where",
  "what",
  "how",
  "why",
  "into",
  "about",
  "just",
  "also",
  "not",
  "no",
  "yes",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "will",
  "can",
  "use",
  "using",
  "used",
  "get",
  "set",
  "new",
  "old",
  "all",
  "any",
  "some",
  "more",
  "most",
  "than",
  "then",
  "them",
  "they",
  "their",
  "there",
  "here",
  "out",
  "up",
  "down",
  "over",
  "under",
  "after",
  "before",
  "once",
  "only",
  "very",
  "too",
  "so",
  "if",
  "else",
  "but",
  "because",
  "while",
  "via",
  "per",
  "etc",
  "todo",
  "fixme",
  "bug",
  "feat",
  "feature",
  "task",
  "card",
  "prompt",
  "mission",
  "work",
  "done",
  "when",
  "constraints",
  // Path noise — every checkout lives under these; they must not match "projects".
  "root",
  "home",
  "users",
  "tmp",
  "var",
  "opt",
  "projects",
  "worktrees",
  "repo",
  "repos",
  "src",
  "app",
  "apps",
  "lib",
  "bin",
  "node",
  "modules",
  "vendor",
  "git",
  "com",
  "org",
  "io",
]);

/** Tokens from title+body worth matching against project identity. */
export function extractPromptKeywords(text: string): string[] {
  const raw = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9_/.\-]+/g, " ")
    .split(/[\s_/.\-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= 48) break;
  }
  return out;
}

function projectIdentityTokens(project: ProjectKeywordTarget): {
  readonly tokens: ReadonlySet<string>;
  readonly slug: string;
} {
  const slug =
    project.slug?.trim() ||
    project.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") ||
    project.id;
  const blob = [project.name, slug, project.workspaceRoot ?? "", project.repo ?? ""]
    .join(" ")
    .toLowerCase();
  const parts = blob
    .replace(/[^a-z0-9_/.\-]+/g, " ")
    .split(/[\s_/.\-]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));
  return { tokens: new Set(parts), slug };
}

/**
 * Rank projects by keyword hits on name / slug / path / repo. Score weights
 * longer tokens higher. Empty when nothing matches — Hermes still picks.
 */
export function rankProjectsByPromptKeywords(input: {
  readonly title: string;
  readonly body: string;
  readonly projects: ReadonlyArray<ProjectKeywordTarget>;
}): ReadonlyArray<ProjectKeywordHit> {
  const keywords = extractPromptKeywords(`${input.title}\n${input.body}`);
  if (keywords.length === 0 || input.projects.length === 0) return [];

  const hits: ProjectKeywordHit[] = [];
  for (const project of input.projects) {
    const { tokens, slug } = projectIdentityTokens(project);
    const matched: string[] = [];
    let score = 0;
    for (const kw of keywords) {
      if (tokens.has(kw)) {
        matched.push(kw);
        score += Math.min(6, kw.length);
        continue;
      }
      // Substring for multi-word project names split oddly (e.g. vpscode vs vps-code).
      for (const part of tokens) {
        if (part.length >= 4 && (part.includes(kw) || kw.includes(part))) {
          matched.push(kw);
          score += Math.min(4, Math.floor(kw.length / 2));
          break;
        }
      }
    }
    if (matched.length === 0) continue;
    // Unique match on a rare token (only one project has "kanban") — boost.
    hits.push({
      projectId: project.id,
      name: project.name,
      slug,
      score,
      matched: [...new Set(matched)],
    });
  }

  hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return hits.slice(0, 8);
}

/** One-line evidence for a routing brief project row. */
export function keywordMatchEvidence(hit: ProjectKeywordHit | undefined): string | null {
  if (!hit || hit.matched.length === 0) return null;
  return `keyword hits: ${hit.matched.slice(0, 6).join(", ")} (score ${hit.score})`;
}
