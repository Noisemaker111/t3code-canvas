/**
 * CanvasStore — server-persisted tldraw document for the board canvas.
 *
 * Holds two things: the browser's snapshot (opaque JSON, last writer wins under
 * an optimistic revision check) and the queue of Hermes-authored drawings that
 * no browser has materialized yet. Persisting server-side is what lets Hermes
 * read the canvas at all — a document that only lives in IndexedDB is invisible
 * to the loop.
 *
 * @module canvas/CanvasStore
 */
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  type CanvasAckInjectionsInput,
  type CanvasAckInjectionsResult,
  type CanvasAckMessagesInput,
  type CanvasAckMessagesResult,
  type CanvasDigest,
  type CanvasDigestInput,
  CanvasDocId,
  type CanvasDocument,
  type CanvasGetInput,
  type CanvasGetResult,
  type CanvasImage,
  type CanvasInjection,
  CanvasInjectionSpec,
  type CanvasListInjectionsInput,
  type CanvasListInjectionsResult,
  type CanvasListMessagesInput,
  type CanvasListMessagesResult,
  type CanvasMessage,
  type CanvasMessageAuthorKind,
  type CanvasMessageTarget,
  CanvasPersistenceError,
  type CanvasPostMessageInput,
  type CanvasPostMessageResult,
  type CanvasSaveInput,
  type CanvasSaveResult,
  CANVAS_MESSAGE_MAX_IMAGE_BYTES,
  DEFAULT_CANVAS_DOC_ID,
} from "@t3tools/contracts";

import { digestSnapshot } from "./canvasDigest.ts";
import { applySnapshotPatch } from "./canvasPatch.ts";

/** A snapshot past this is a runaway document, not a drawing. */
const MAX_SNAPSHOT_BYTES = 12 * 1024 * 1024;
/** Unapplied injections replay on reload; cap what one page load must absorb. */
const MAX_PENDING_INJECTIONS = 50;
const DEFAULT_MESSAGE_LIMIT = 25;
const MAX_MESSAGE_LIMIT = 100;

const DocumentRow = Schema.Struct({
  docId: Schema.Unknown,
  snapshotJson: Schema.optional(Schema.Unknown),
  revision: Schema.Unknown,
  updatedAt: Schema.Unknown,
});

const InjectionRow = Schema.Struct({
  id: Schema.Unknown,
  docId: Schema.Unknown,
  specJson: Schema.Unknown,
  createdAt: Schema.Unknown,
  appliedAt: Schema.optional(Schema.Unknown),
});

const MessageRow = Schema.Struct({
  id: Schema.Unknown,
  docId: Schema.Unknown,
  authorKind: Schema.Unknown,
  authorId: Schema.optional(Schema.Unknown),
  text: Schema.Unknown,
  imageMediaType: Schema.optional(Schema.Unknown),
  imageData: Schema.optional(Schema.Unknown),
  imageWidth: Schema.optional(Schema.Unknown),
  imageHeight: Schema.optional(Schema.Unknown),
  target: Schema.Unknown,
  targetId: Schema.optional(Schema.Unknown),
  createdAt: Schema.Unknown,
  deliveredAt: Schema.optional(Schema.Unknown),
});

const decodeDate = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString);
// A spec that does not decode must never leave this store: the RPC layer
// re-encodes responses against the contract, so one junk row (written before
// enqueue validated its input) made canvas.listInjections undeliverable for
// every browser until the row was deleted by hand.
const decodeInjectionSpec = Schema.decodeUnknownResult(CanvasInjectionSpec);

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function persistenceError(operation: string) {
  return (cause: unknown): CanvasPersistenceError =>
    new CanvasPersistenceError({
      operation,
      detail: cause instanceof Error ? cause.message : undefined,
      cause,
    });
}

export class CanvasStore extends Context.Service<
  CanvasStore,
  {
    readonly get: (
      input?: CanvasGetInput,
    ) => Effect.Effect<CanvasGetResult, CanvasPersistenceError>;
    readonly save: (
      input: CanvasSaveInput,
    ) => Effect.Effect<CanvasSaveResult, CanvasPersistenceError>;
    readonly listInjections: (
      input?: CanvasListInjectionsInput,
    ) => Effect.Effect<CanvasListInjectionsResult, CanvasPersistenceError>;
    readonly ackInjections: (
      input: CanvasAckInjectionsInput,
    ) => Effect.Effect<CanvasAckInjectionsResult, CanvasPersistenceError>;
    /** What Hermes sees when it reads the canvas. */
    readonly digest: (
      input?: CanvasDigestInput,
    ) => Effect.Effect<CanvasDigest, CanvasPersistenceError>;
    /** Queue one drawing for the browser to materialize. */
    readonly enqueueInjection: (input: {
      readonly docId?: CanvasDocId;
      readonly spec: CanvasInjectionSpec;
    }) => Effect.Effect<CanvasInjection, CanvasPersistenceError>;
    readonly postMessage: (
      input: CanvasPostMessageInput,
    ) => Effect.Effect<CanvasPostMessageResult, CanvasPersistenceError>;
    readonly listMessages: (
      input?: CanvasListMessagesInput,
    ) => Effect.Effect<CanvasListMessagesResult, CanvasPersistenceError>;
    readonly ackMessages: (
      input: CanvasAckMessagesInput,
    ) => Effect.Effect<CanvasAckMessagesResult, CanvasPersistenceError>;
  }
>()("t3/canvas/CanvasStore") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const findDoc = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: DocumentRow,
    execute: (docId) => sql`
      SELECT doc_id AS "docId", snapshot_json AS "snapshotJson", revision AS "revision",
             updated_at AS "updatedAt"
      FROM canvas_documents WHERE doc_id = ${docId}
    `,
  });

  const findPending = SqlSchema.findAll({
    Request: Schema.String,
    Result: InjectionRow,
    execute: (docId) => sql`
      SELECT id AS "id", doc_id AS "docId", spec_json AS "specJson",
             created_at AS "createdAt", applied_at AS "appliedAt"
      FROM canvas_injections
      WHERE doc_id = ${docId} AND applied_at IS NULL
      ORDER BY created_at ASC
      LIMIT ${MAX_PENDING_INJECTIONS}
    `,
  });

  const readDoc = (docId: CanvasDocId, operation: string) =>
    findDoc(docId).pipe(
      Effect.mapError(persistenceError(operation)),
      Effect.map(
        (row): CanvasDocument =>
          Option.match(row, {
            onNone: () => ({
              docId,
              snapshot: null,
              revision: 0,
              updatedAt: DateTime.makeUnsafe(0),
            }),
            onSome: (found) => ({
              docId,
              snapshot: asString(found.snapshotJson),
              revision: asNumber(found.revision),
              updatedAt: decodeDate(String(found.updatedAt)),
            }),
          }),
      ),
    );

  const get: CanvasStore["Service"]["get"] = (input) =>
    readDoc(input?.docId ?? DEFAULT_CANVAS_DOC_ID, "CanvasStore.get").pipe(
      Effect.map((document) => ({ document })),
    );

  const save: CanvasStore["Service"]["save"] = (input) =>
    Effect.gen(function* () {
      const docId = input.docId ?? DEFAULT_CANVAS_DOC_ID;
      const offered = input.snapshot ?? input.patch?.putJson ?? null;
      if (offered === null) {
        return yield* new CanvasPersistenceError({
          operation: "CanvasStore.save",
          detail: "a save needs either a snapshot or a patch",
          cause: null,
        });
      }
      if (offered.length > MAX_SNAPSHOT_BYTES) {
        return yield* new CanvasPersistenceError({
          operation: "CanvasStore.save",
          detail: `snapshot is ${offered.length} bytes, over the ${MAX_SNAPSHOT_BYTES} cap`,
          cause: null,
        });
      }
      const current = yield* readDoc(docId, "CanvasStore.save:read");
      if (input.baseRevision !== undefined && input.baseRevision !== current.revision) {
        return { docId, revision: current.revision, saved: false };
      }

      // A patch the server cannot merge is reported unsaved rather than
      // guessed at: the browser's answer to both that and a stale revision is
      // to send the whole document, which is the one write that cannot be wrong.
      const snapshot =
        input.patch === undefined
          ? (input.snapshot ?? null)
          : applySnapshotPatch(current.snapshot, input.patch);
      if (snapshot === null) return { docId, revision: current.revision, saved: false };
      if (snapshot.length > MAX_SNAPSHOT_BYTES) {
        return yield* new CanvasPersistenceError({
          operation: "CanvasStore.save",
          detail: `patched snapshot is ${snapshot.length} bytes, over the ${MAX_SNAPSHOT_BYTES} cap`,
          cause: null,
        });
      }

      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const revision = current.revision + 1;
      yield* sql`
        INSERT INTO canvas_documents (doc_id, snapshot_json, revision, created_at, updated_at)
        VALUES (${docId}, ${snapshot}, ${revision}, ${nowIso}, ${nowIso})
        ON CONFLICT(doc_id) DO UPDATE SET
          snapshot_json = excluded.snapshot_json,
          revision = excluded.revision,
          updated_at = excluded.updated_at
      `.pipe(Effect.mapError(persistenceError("CanvasStore.save")));
      return { docId, revision, saved: true };
    });

  const toInjection = (row: typeof InjectionRow.Type): CanvasInjection | null => {
    const specRaw = asString(row.specJson);
    if (specRaw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(specRaw);
    } catch {
      return null;
    }
    const decoded = decodeInjectionSpec(parsed);
    if (Result.isFailure(decoded)) return null;
    const spec = decoded.success;
    const appliedAt = asString(row.appliedAt);
    return {
      id: String(row.id),
      docId: CanvasDocId.make(String(row.docId)),
      spec,
      createdAt: decodeDate(String(row.createdAt)),
      appliedAt: appliedAt === null ? null : decodeDate(appliedAt),
    };
  };

  const listInjections: CanvasStore["Service"]["listInjections"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* findPending(input?.docId ?? DEFAULT_CANVAS_DOC_ID).pipe(
        Effect.mapError(persistenceError("CanvasStore.listInjections")),
      );
      const injections: Array<CanvasInjection> = [];
      const invalid: Array<string> = [];
      for (const row of rows) {
        const injection = toInjection(row);
        if (injection !== null) injections.push(injection);
        else invalid.push(String(row.id));
      }
      // Retire junk rows instead of replaying them: left pending they fill the
      // replay window and shadow real drawings behind the LIMIT.
      if (invalid.length > 0) {
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          UPDATE canvas_injections SET applied_at = ${nowIso}
          WHERE applied_at IS NULL AND id IN ${sql.in(invalid)}
        `.pipe(Effect.mapError(persistenceError("CanvasStore.listInjections:retire")));
      }
      return { injections };
    });

  const ackInjections: CanvasStore["Service"]["ackInjections"] = (input) =>
    Effect.gen(function* () {
      if (input.ids.length === 0) return { acked: 0 };
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE canvas_injections SET applied_at = ${nowIso}
        WHERE applied_at IS NULL AND id IN ${sql.in(input.ids)}
      `.pipe(Effect.mapError(persistenceError("CanvasStore.ackInjections")));
      return { acked: input.ids.length };
    });

  const digest: CanvasStore["Service"]["digest"] = (input) =>
    Effect.gen(function* () {
      const docId = input?.docId ?? DEFAULT_CANVAS_DOC_ID;
      const document = yield* readDoc(docId, "CanvasStore.digest");
      const body = digestSnapshot(document.snapshot);
      return {
        docId: document.docId,
        revision: document.revision,
        shapeCount: body.shapeCount,
        untitledCount: body.untitledCount,
        shapes: body.shapes,
        updatedAt: document.revision === 0 ? null : document.updatedAt,
      };
    });

  const toMessage = (row: typeof MessageRow.Type): CanvasMessage => {
    const mediaType = asString(row.imageMediaType);
    const data = asString(row.imageData);
    const width = asNumber(row.imageWidth);
    const height = asNumber(row.imageHeight);
    const image: CanvasImage | null =
      mediaType === null || data === null
        ? null
        : {
            mediaType: mediaType as CanvasImage["mediaType"],
            data,
            ...(width > 0 ? { width } : {}),
            ...(height > 0 ? { height } : {}),
          };
    const deliveredAt = asString(row.deliveredAt);
    return {
      id: String(row.id),
      docId: CanvasDocId.make(String(row.docId)),
      authorKind: (asString(row.authorKind) ?? "human") as CanvasMessageAuthorKind,
      authorId: asString(row.authorId),
      text: asString(row.text) ?? "",
      image,
      hasImage: mediaType !== null && data !== null,
      target: (asString(row.target) ?? "hermes") as CanvasMessageTarget,
      targetId: asString(row.targetId),
      createdAt: decodeDate(String(row.createdAt)),
      deliveredAt: deliveredAt === null ? null : decodeDate(deliveredAt),
    };
  };

  const postMessage: CanvasStore["Service"]["postMessage"] = (input) =>
    Effect.gen(function* () {
      const docId = input.docId ?? DEFAULT_CANVAS_DOC_ID;
      const image = input.image ?? null;
      if (image !== null && image.data.length > CANVAS_MESSAGE_MAX_IMAGE_BYTES) {
        return yield* new CanvasPersistenceError({
          operation: "CanvasStore.postMessage",
          detail: `image is ${image.data.length} bytes, over the ${CANVAS_MESSAGE_MAX_IMAGE_BYTES} cap`,
          cause: null,
        });
      }
      if (image === null && input.text.length === 0) {
        return yield* new CanvasPersistenceError({
          operation: "CanvasStore.postMessage",
          detail: "a message needs a comment, a picture, or both",
          cause: null,
        });
      }
      const id = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(persistenceError("CanvasStore.postMessage:id")),
      );
      const createdAt = yield* DateTime.now;
      const message: CanvasMessage = {
        id,
        docId,
        authorKind: input.authorKind,
        authorId: input.authorId ?? null,
        text: input.text,
        image,
        hasImage: image !== null,
        target: input.target,
        targetId: input.targetId ?? null,
        createdAt,
        deliveredAt: null,
      };
      yield* sql`
        INSERT INTO canvas_messages
          (id, doc_id, author_kind, author_id, text, image_media_type, image_data,
           image_width, image_height, target, target_id, created_at, delivered_at)
        VALUES (${id}, ${docId}, ${message.authorKind}, ${message.authorId},
                ${message.text}, ${image?.mediaType ?? null}, ${image?.data ?? null},
                ${image?.width ?? null}, ${image?.height ?? null}, ${message.target},
                ${message.targetId}, ${DateTime.formatIso(createdAt)}, NULL)
      `.pipe(Effect.mapError(persistenceError("CanvasStore.postMessage")));
      return { message };
    });

  const listMessages: CanvasStore["Service"]["listMessages"] = (input) =>
    Effect.gen(function* () {
      const docId = input?.docId ?? DEFAULT_CANVAS_DOC_ID;
      const undeliveredOnly = input?.undeliveredOnly ?? true;
      const limit = Math.min(Math.max(1, input?.limit ?? DEFAULT_MESSAGE_LIMIT), MAX_MESSAGE_LIMIT);
      const target = input?.target ?? null;
      const targetId = input?.targetId ?? null;

      const rows = yield* sql`
        SELECT id AS "id", doc_id AS "docId", author_kind AS "authorKind",
               author_id AS "authorId", text AS "text", image_media_type AS "imageMediaType",
               image_data AS "imageData", image_width AS "imageWidth",
               image_height AS "imageHeight", target AS "target", target_id AS "targetId",
               created_at AS "createdAt", delivered_at AS "deliveredAt"
        FROM canvas_messages
        WHERE doc_id = ${docId}
          ${undeliveredOnly ? sql`AND delivered_at IS NULL` : sql``}
          ${target === null ? sql`` : sql`AND target = ${target}`}
          ${targetId === null ? sql`` : sql`AND (target_id IS NULL OR target_id = ${targetId})`}
        ORDER BY created_at ASC
        LIMIT ${limit}
      `.pipe(Effect.mapError(persistenceError("CanvasStore.listMessages")));

      const includeImages = input?.includeImages ?? false;
      const messages = rows.map((row) => {
        const message = toMessage(row as unknown as typeof MessageRow.Type);
        return includeImages ? message : { ...message, image: null };
      });
      return { messages };
    });

  const ackMessages: CanvasStore["Service"]["ackMessages"] = (input) =>
    Effect.gen(function* () {
      if (input.ids.length === 0) return { acked: 0 };
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE canvas_messages SET delivered_at = ${nowIso}
        WHERE delivered_at IS NULL AND id IN ${sql.in(input.ids)}
      `.pipe(Effect.mapError(persistenceError("CanvasStore.ackMessages")));
      return { acked: input.ids.length };
    });

  const enqueueInjection: CanvasStore["Service"]["enqueueInjection"] = (input) =>
    Effect.gen(function* () {
      const docId = input.docId ?? DEFAULT_CANVAS_DOC_ID;
      const id = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(persistenceError("CanvasStore.enqueueInjection:id")),
      );
      const createdAt = yield* DateTime.now;
      const createdAtIso = DateTime.formatIso(createdAt);
      yield* sql`
        INSERT INTO canvas_injections (id, doc_id, spec_json, created_at, applied_at)
        VALUES (${id}, ${docId}, ${JSON.stringify(input.spec)}, ${createdAtIso}, NULL)
      `.pipe(Effect.mapError(persistenceError("CanvasStore.enqueueInjection")));
      return { id, docId, spec: input.spec, createdAt, appliedAt: null };
    });

  return {
    get,
    save,
    listInjections,
    ackInjections,
    digest,
    enqueueInjection,
    postMessage,
    listMessages,
    ackMessages,
  } satisfies CanvasStore["Service"];
});

export const layer = Layer.effect(CanvasStore, make);
