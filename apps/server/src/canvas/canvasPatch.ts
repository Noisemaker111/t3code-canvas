/**
 * Merge a partial write into the stored tldraw snapshot.
 *
 * The server still does not read tldraw's schema — it only needs the address of
 * the record map so a stroke can cost one record instead of the whole canvas.
 * Anything it is not sure of returns `null`, which the caller turns into an
 * unsaved result so the browser resends the whole document rather than having a
 * guess written over its work.
 *
 * @module canvas/canvasPatch
 */
import type { CanvasSavePatch } from "@t3tools/contracts";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Where the record map lives in the snapshot this build writes.
 *
 * Deliberately stricter than the digest's `findRecords`, which guesses across
 * every layout tldraw has ever shipped. Guessing is fine when the worst case is
 * an empty summary; here the worst case is a merge into the wrong object, so an
 * unrecognized layout is a refusal.
 */
function recordMap(snapshot: Json): Json | null {
  const document = snapshot.document;
  if (!isObject(document)) return null;
  const store = document.store;
  return isObject(store) ? store : null;
}

/**
 * The stored snapshot with `patch` applied, or null when it cannot be applied:
 * nothing stored yet, unparseable JSON, a layout without the record map, or a
 * `putJson` that is not an object of records.
 */
export function applySnapshotPatch(stored: string | null, patch: CanvasSavePatch): string | null {
  if (stored === null || stored.length === 0) return null;

  let snapshot: unknown;
  let put: unknown;
  try {
    snapshot = JSON.parse(stored);
    put = JSON.parse(patch.putJson);
  } catch {
    return null;
  }
  if (!isObject(snapshot) || !isObject(put)) return null;

  const store = recordMap(snapshot);
  if (store === null) return null;

  // A put that is not a record would land in the map as junk that every later
  // read has to survive; refuse the whole patch instead of half-applying it.
  for (const record of Object.values(put)) {
    if (!isObject(record) || typeof record.typeName !== "string") return null;
  }

  const nextStore: Json = { ...store, ...put };
  for (const id of patch.removeIds) delete nextStore[id];

  // Everything outside the record map — the schema, and the session half the
  // camera lives in — is carried through untouched. Only the document scope
  // reaches the browser's save listener, so it is the only scope that changed.
  const document = snapshot.document as Json;
  return JSON.stringify({ ...snapshot, document: { ...document, store: nextStore } });
}
