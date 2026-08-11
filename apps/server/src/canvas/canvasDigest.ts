/**
 * Read an opaque tldraw snapshot well enough for Hermes to talk about it.
 *
 * The server never writes tldraw records, so it does not need tldraw's schema —
 * only enough leniency to survive its version drift. Everything here degrades
 * to "no shapes" rather than throwing: a canvas Hermes cannot parse must not
 * take the board down.
 *
 * @module canvas/canvasDigest
 */
import type { CanvasDigestShape } from "@t3tools/contracts";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** tldraw has moved the record map more than once; accept every layout seen. */
function findRecords(snapshot: unknown): ReadonlyArray<Json> {
  if (!isObject(snapshot)) return [];
  const candidates: ReadonlyArray<unknown> = [
    isObject(snapshot.document) ? snapshot.document.store : undefined,
    snapshot.store,
    snapshot.records,
    snapshot,
  ];
  for (const candidate of candidates) {
    if (!isObject(candidate)) continue;
    const records = Object.values(candidate).filter(isObject);
    if (records.some((record) => typeof record.typeName === "string")) return records;
  }
  return [];
}

/**
 * Shape text lives in `props.text` on older shapes and in `props.richText` (a
 * ProseMirror doc) on newer ones. Walk both; cap the depth so a cyclic or
 * pathological document cannot spin.
 */
function extractText(value: unknown, depth = 0): string {
  if (depth > 12) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => extractText(entry, depth + 1))
      .filter((entry) => entry.length > 0)
      .join(" ");
  }
  if (!isObject(value)) return "";
  const parts: Array<string> = [];
  if (typeof value.text === "string") parts.push(value.text);
  if (Array.isArray(value.content)) parts.push(extractText(value.content, depth + 1));
  return parts.filter((part) => part.length > 0).join(" ");
}

function shapeText(shape: Json): string {
  const props = isObject(shape.props) ? shape.props : {};
  const fromText = typeof props.text === "string" ? props.text : "";
  const text = fromText.length > 0 ? fromText : extractText(props.richText);
  return text.replaceAll(/\s+/g, " ").trim();
}

function coord(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Keep a runaway canvas from blowing up a Hermes prompt. */
const MAX_DIGEST_SHAPES = 120;
const MAX_TEXT_CHARS = 240;
/** A parent chain longer than this is a corrupt document, not a deep group. */
const MAX_PARENT_DEPTH = 16;

export type CanvasDigestBody = {
  readonly shapeCount: number;
  readonly untitledCount: number;
  readonly shapes: ReadonlyArray<CanvasDigestShape>;
};

const EMPTY: CanvasDigestBody = {
  shapeCount: 0,
  untitledCount: 0,
  shapes: [],
};

/**
 * Resolve a shape to page coordinates by walking parents. tldraw stores a child
 * relative to its frame, so a digest reporting raw x/y would tell Hermes a box
 * is at (40, 40) when the human sees it a screen away. Rotation is not
 * composed: every frame this system writes is axis-aligned, and a rotated group
 * deserves an approximate answer over none.
 */
function resolve(
  shape: Json,
  byId: ReadonlyMap<string, Json>,
): { readonly x: number; readonly y: number } {
  let x = coord(shape.x);
  let y = coord(shape.y);
  let parentId = typeof shape.parentId === "string" ? shape.parentId : null;

  for (let depth = 0; depth < MAX_PARENT_DEPTH && parentId !== null; depth += 1) {
    const parent = byId.get(parentId);
    if (parent === undefined || parent.typeName !== "shape") break;
    x += coord(parent.x);
    y += coord(parent.y);
    parentId = typeof parent.parentId === "string" ? parent.parentId : null;
  }

  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * Flatten a snapshot into the shapes that carry text, plus a count of the ones
 * that do not — drawings Hermes can know exist but cannot read.
 */
export function digestSnapshot(snapshotJson: string | null): CanvasDigestBody {
  if (snapshotJson === null || snapshotJson.trim().length === 0) return EMPTY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshotJson);
  } catch {
    return EMPTY;
  }

  const records = findRecords(parsed);
  const byId = new Map<string, Json>();
  for (const record of records) {
    if (typeof record.id === "string") byId.set(record.id, record);
  }

  const shapes: Array<CanvasDigestShape> = [];
  let shapeCount = 0;
  let untitledCount = 0;

  for (const record of records) {
    if (record.typeName !== "shape") continue;
    const resolved = resolve(record, byId);

    shapeCount += 1;
    const text = shapeText(record);
    if (text.length === 0) {
      untitledCount += 1;
      continue;
    }
    if (shapes.length >= MAX_DIGEST_SHAPES) continue;
    shapes.push({
      id: typeof record.id === "string" ? record.id : "",
      kind: typeof record.type === "string" ? record.type : "shape",
      text: text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text,
      x: resolved.x,
      y: resolved.y,
    });
  }

  return { shapeCount, untitledCount, shapes };
}
