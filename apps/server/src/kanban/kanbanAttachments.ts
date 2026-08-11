/**
 * Persist and resolve kanban composer media on disk.
 *
 * Metadata rides the card row; bytes sit next to thread attachments under
 * `attachmentsDir/kanban/<id>.<ext>` so Launch and Hermes can re-read them
 * without shipping base64 on every board poll.
 *
 * @module kanban/kanbanAttachments
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type {
  KanbanCardAttachment,
  KanbanCardAttachmentKind,
  KanbanUploadCardAttachment,
} from "@t3tools/contracts";
import {
  KANBAN_CARD_MAX_ATTACHMENTS,
  KANBAN_CARD_MAX_IMAGE_BYTES,
  KANBAN_CARD_MAX_VIDEO_BYTES,
} from "@t3tools/contracts";

import { inferImageExtension } from "../imageMime.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";

const VIDEO_EXTENSION_BY_MIME: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
};

export function kanbanAttachmentsRoot(attachmentsDir: string): string {
  return NodePath.join(attachmentsDir, "kanban");
}

export function inferKanbanMediaExtension(input: {
  kind: KanbanCardAttachmentKind;
  mimeType: string;
  fileName?: string;
}): string {
  if (input.kind === "image") {
    return inferImageExtension({
      mimeType: input.mimeType,
      ...(input.fileName !== undefined ? { fileName: input.fileName } : {}),
    });
  }
  const fromMime = VIDEO_EXTENSION_BY_MIME[input.mimeType.toLowerCase()];
  if (fromMime) return fromMime;
  const name = input.fileName?.toLowerCase() ?? "";
  for (const ext of [".mp4", ".webm", ".mov"]) {
    if (name.endsWith(ext)) return ext;
  }
  return ".bin";
}

export function kanbanAttachmentRelativePath(attachment: KanbanCardAttachment): string {
  const extension = inferKanbanMediaExtension({
    kind: attachment.kind,
    mimeType: attachment.mimeType,
    fileName: attachment.name,
  });
  return NodePath.join("kanban", `${attachment.id}${extension}`);
}

export function resolveKanbanAttachmentPath(input: {
  readonly attachmentsDir: string;
  readonly attachment: KanbanCardAttachment;
}): string | null {
  return resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: kanbanAttachmentRelativePath(input.attachment),
  });
}

export function decodeAttachmentsJson(raw: string | null | undefined): KanbanCardAttachment[] {
  if (!raw || raw.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const row = entry as Record<string, unknown>;
      const id = typeof row.id === "string" ? row.id : null;
      const kind = row.kind === "image" || row.kind === "video" ? row.kind : null;
      const name = typeof row.name === "string" ? row.name : null;
      const mimeType = typeof row.mimeType === "string" ? row.mimeType : null;
      const sizeBytes = typeof row.sizeBytes === "number" ? row.sizeBytes : null;
      if (!id || !kind || !name || !mimeType || sizeBytes === null) return [];
      return [
        {
          id,
          kind,
          name,
          mimeType,
          sizeBytes,
          include: row.include === false ? false : true,
        } satisfies KanbanCardAttachment,
      ];
    });
  } catch {
    return [];
  }
}

export function encodeAttachmentsJson(attachments: ReadonlyArray<KanbanCardAttachment>): string {
  return JSON.stringify(attachments);
}

export type PersistKanbanUploadsResult =
  | { readonly ok: true; readonly attachments: ReadonlyArray<KanbanCardAttachment> }
  | { readonly ok: false; readonly error: string };

/**
 * Validate uploads, write bytes to disk, return metadata for the card row.
 * Empty input is a no-op success with `[]` — plain-text creates stay unchanged.
 */
export function persistKanbanUploads(input: {
  readonly attachmentsDir: string;
  readonly uploads: ReadonlyArray<KanbanUploadCardAttachment>;
  readonly ids: ReadonlyArray<string>;
}): PersistKanbanUploadsResult {
  if (input.uploads.length === 0) {
    return { ok: true, attachments: [] };
  }
  if (input.uploads.length > KANBAN_CARD_MAX_ATTACHMENTS) {
    return {
      ok: false,
      error: `At most ${KANBAN_CARD_MAX_ATTACHMENTS} attachments per card.`,
    };
  }
  if (input.ids.length !== input.uploads.length) {
    return { ok: false, error: "Attachment id count does not match uploads." };
  }

  const root = kanbanAttachmentsRoot(input.attachmentsDir);
  try {
    NodeFS.mkdirSync(root, { recursive: true });
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : "Failed to create kanban attachments dir.",
    };
  }

  const attachments: KanbanCardAttachment[] = [];
  for (let index = 0; index < input.uploads.length; index++) {
    const upload = input.uploads[index]!;
    const id = input.ids[index]!;
    const expectedPrefix = upload.kind === "image" ? "image/" : "video/";
    if (!upload.mimeType.toLowerCase().startsWith(expectedPrefix)) {
      return {
        ok: false,
        error: `Attachment '${upload.name}' mime '${upload.mimeType}' does not match kind '${upload.kind}'.`,
      };
    }
    const maxBytes =
      upload.kind === "image" ? KANBAN_CARD_MAX_IMAGE_BYTES : KANBAN_CARD_MAX_VIDEO_BYTES;
    const parsed = parseBase64DataUrl(upload.dataUrl);
    if (!parsed) {
      return { ok: false, error: `Invalid data URL for '${upload.name}'.` };
    }
    const bytes = Buffer.from(parsed.base64, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
      return {
        ok: false,
        error: `Attachment '${upload.name}' is empty or exceeds the ${Math.round(maxBytes / (1024 * 1024))}MB limit.`,
      };
    }

    const attachment: KanbanCardAttachment = {
      id,
      kind: upload.kind,
      name: upload.name,
      mimeType: parsed.mimeType.toLowerCase(),
      sizeBytes: bytes.byteLength,
      include: true,
    };
    const path = resolveKanbanAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (!path) {
      return { ok: false, error: `Failed to resolve path for '${upload.name}'.` };
    }
    try {
      NodeFS.writeFileSync(path, bytes);
    } catch (cause) {
      return {
        ok: false,
        error:
          cause instanceof Error ? cause.message : `Failed to write attachment '${upload.name}'.`,
      };
    }
    attachments.push(attachment);
  }

  return { ok: true, attachments };
}

export function readKanbanAttachmentBytes(input: {
  readonly attachmentsDir: string;
  readonly attachment: KanbanCardAttachment;
}): Buffer | null {
  const path = resolveKanbanAttachmentPath(input);
  if (!path || !NodeFS.existsSync(path)) return null;
  try {
    return NodeFS.readFileSync(path);
  } catch {
    return null;
  }
}

export function applyKeepAttachmentIds(
  attachments: ReadonlyArray<KanbanCardAttachment>,
  keepAttachmentIds: ReadonlyArray<string> | undefined,
): KanbanCardAttachment[] {
  if (keepAttachmentIds === undefined) {
    return attachments.map((entry) => ({ ...entry }));
  }
  const keep = new Set(keepAttachmentIds);
  return attachments.map((entry) => ({
    ...entry,
    include: keep.has(entry.id),
  }));
}

/** Images Hermes should see this tick — included image attachments only. */
export function hermesImagesFromCardAttachments(input: {
  readonly attachmentsDir: string;
  readonly attachments: ReadonlyArray<KanbanCardAttachment>;
}): Array<{ mediaType: string; data: string }> {
  const out: Array<{ mediaType: string; data: string }> = [];
  for (const attachment of input.attachments) {
    if (attachment.kind !== "image" || attachment.include === false) continue;
    const bytes = readKanbanAttachmentBytes({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (!bytes || bytes.byteLength === 0) {
      throw new Error(
        `Included kanban attachment '${attachment.name}' (${attachment.id}) is missing or empty.`,
      );
    }
    out.push({
      mediaType: attachment.mimeType,
      data: bytes.toString("base64"),
    });
  }
  return out;
}
