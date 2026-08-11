// @effect-diagnostics nodeBuiltinImport:off
/**
 * Model capability from a benchmark snapshot on disk, keyed like the price
 * catalog (`org/slug` and bare slug).
 *
 * One axis per kind of work the board actually routes — a model that tops a
 * coding leaderboard is not thereby good at terminal ops or at design, and
 * collapsing them into one number is how "High IQ" ends up hand-typed in a
 * settings box. Each axis carries its own source, and each is written by a
 * separate feed via `scripts/fetch-model-capability.mjs --axis=<name>`.
 *
 * Cost is deliberately absent: this box measures $/task from real prices and
 * observed tokens, which beats any published cost-per-task figure.
 *
 * No snapshot means every axis is unknown — never a guess.
 *
 * @module kanban/ModelCapabilityCatalog
 */
import * as NodeFSP from "node:fs/promises";

const DEFAULT_SNAPSHOT_PATH = "/opt/t3j/model-capability.json";

export function modelCapabilitySnapshotPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.T3CODE_MODEL_CAPABILITY_FILE?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_SNAPSHOT_PATH;
}

/** The kinds of work the board routes. Adding one means adding a feed for it. */
export const CAPABILITY_AXES = ["coding", "it", "design", "planning"] as const;
export type CapabilityAxis = (typeof CAPABILITY_AXES)[number];

export type ModelCapabilityEntry = {
  readonly id: string;
  /**
   * Score per axis on whatever scale its feed publishes — a 0..100 pass rate and
   * an Elo are both fine, because rows are only ever compared within an axis.
   */
  readonly scores: Readonly<Record<CapabilityAxis, number | null>>;
  /** Which benchmark produced each axis. Absent axis, absent source. */
  readonly sources: Readonly<Partial<Record<CapabilityAxis, string>>>;
  /** Context the model holds *well*, not the advertised window. */
  readonly effectiveContextTokens: number | null;
  readonly fetchedAt: string | null;
};

/** Convenience for the many callers that only care about the coding axis. */
export const codingScoreOf = (entry: ModelCapabilityEntry | null): number | null =>
  entry?.scores.coding ?? null;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Snapshot shape: `{ fetchedAt, models: { [id]: { coding?: {score, source},
 * it?, design?, planning?, effectiveContextTokens? } } }`. A row may also carry
 * the single-axis `codingScore` / `source` pair the first snapshots used.
 * Rows that do not parse are skipped.
 */
export function parseCapabilitySnapshot(raw: unknown): ReadonlyMap<string, ModelCapabilityEntry> {
  const byId = new Map<string, ModelCapabilityEntry>();
  const root = record(raw);
  const models = record(root?.models);
  if (!models) return byId;
  const fetchedAt = typeof root?.fetchedAt === "string" ? root.fetchedAt : null;
  for (const [id, value] of Object.entries(models)) {
    const row = record(value);
    if (!row) continue;
    const legacySource =
      typeof row.source === "string" && row.source.trim() ? row.source : "snapshot";
    const scores: Record<CapabilityAxis, number | null> = {
      coding: null,
      it: null,
      design: null,
      planning: null,
    };
    const sources: Partial<Record<CapabilityAxis, string>> = {};
    for (const axis of CAPABILITY_AXES) {
      const cell = record(row[axis]);
      const score = cell ? num(cell.score) : null;
      if (score === null) continue;
      scores[axis] = score;
      sources[axis] =
        typeof cell?.source === "string" && cell.source.trim() ? cell.source : "snapshot";
    }
    // The one-axis snapshot shape predates the others; it only ever meant coding.
    if (scores.coding === null && num(row.codingScore) !== null) {
      scores.coding = num(row.codingScore);
      sources.coding = legacySource;
    }
    const entry: ModelCapabilityEntry = {
      id,
      scores,
      sources,
      effectiveContextTokens: num(row.effectiveContextTokens),
      fetchedAt,
    };
    byId.set(id, entry);
    const bare = id.split("/").pop();
    if (bare && !byId.has(bare)) byId.set(bare, entry);
  }
  return byId;
}

type Snapshot = {
  readonly mtimeMs: number;
  readonly byId: ReadonlyMap<string, ModelCapabilityEntry>;
};

let cached: Snapshot | null = null;

/** Re-reads only when the fetcher has rewritten the file. Null when absent. */
export async function getModelCapabilityCatalog(
  path = modelCapabilitySnapshotPath(),
): Promise<ReadonlyMap<string, ModelCapabilityEntry> | null> {
  try {
    const stat = await NodeFSP.stat(path);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.byId;
    const byId = parseCapabilitySnapshot(JSON.parse(await NodeFSP.readFile(path, "utf8")));
    if (byId.size === 0) return null;
    cached = { mtimeMs: stat.mtimeMs, byId };
    return byId;
  } catch {
    return null;
  }
}

/** Match a harness's bare CLI slug the way the price catalog does. */
export function capabilityForModel(
  byId: ReadonlyMap<string, ModelCapabilityEntry> | null,
  model: string,
): ModelCapabilityEntry | null {
  if (!byId) return null;
  const slug = model.trim().toLowerCase();
  if (!slug) return null;
  const direct = byId.get(slug) ?? byId.get(model.trim());
  if (direct) return direct;
  for (const [id, entry] of byId) {
    if (id.endsWith(`/${slug}`)) return entry;
  }
  return null;
}
