/**
 * Board-composer media attach helpers (pick/paste/drop validation).
 *
 * @module components/kanban/kanbanComposerMedia
 */
import {
  KANBAN_CARD_MAX_ATTACHMENTS,
  KANBAN_CARD_MAX_IMAGE_BYTES,
  KANBAN_CARD_MAX_VIDEO_BYTES,
  type KanbanCardAttachmentKind,
  type KanbanUploadCardAttachment,
} from "@t3tools/contracts";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import { readFileAsDataUrl } from "../ChatView.logic";

export type KanbanComposerMediaKind = KanbanCardAttachmentKind;

export function kanbanMediaKindForFile(file: File): KanbanComposerMediaKind | null {
  const mime = file.type.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return null;
}

export function kanbanMediaSizeLimit(kind: KanbanComposerMediaKind): number {
  return kind === "image" ? KANBAN_CARD_MAX_IMAGE_BYTES : KANBAN_CARD_MAX_VIDEO_BYTES;
}

export function kanbanMediaSizeLimitLabel(kind: KanbanComposerMediaKind): string {
  return `${Math.round(kanbanMediaSizeLimit(kind) / (1024 * 1024))}MB`;
}

export type AcceptKanbanMediaResult =
  | { readonly ok: true; readonly files: File[] }
  | { readonly ok: false; readonly error: string };

/** Filter a file list for the board composer; first error wins. */
export function acceptKanbanMediaFiles(input: {
  readonly files: ReadonlyArray<File>;
  readonly currentCount: number;
}): AcceptKanbanMediaResult {
  const accepted: File[] = [];
  let nextCount = input.currentCount;
  for (const file of input.files) {
    const kind = kanbanMediaKindForFile(file);
    if (!kind) {
      return {
        ok: false,
        error: `Unsupported file type for '${file.name}'. Attach images or videos only.`,
      };
    }
    if (file.size > kanbanMediaSizeLimit(kind)) {
      return {
        ok: false,
        error: `'${file.name}' exceeds the ${kanbanMediaSizeLimitLabel(kind)} ${kind} limit.`,
      };
    }
    if (nextCount >= KANBAN_CARD_MAX_ATTACHMENTS) {
      return {
        ok: false,
        error: `You can attach up to ${KANBAN_CARD_MAX_ATTACHMENTS} files per board message.`,
      };
    }
    accepted.push(file);
    nextCount += 1;
  }
  return { ok: true, files: accepted };
}

export function filesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  return Array.from(data.items)
    .filter((item) => item.kind === "file")
    .map((item, index) => {
      const blob = item.getAsFile();
      if (!blob) return null;
      const kind = kanbanMediaKindForFile(blob);
      if (!kind) return null;
      if (blob.name && blob.name.length > 0) return blob;
      const ext = blob.type.split("/")[1] ?? (kind === "image" ? "png" : "webm");
      return new File([blob], `pasted-${kind}-${index + 1}.${ext}`, { type: blob.type });
    })
    .filter((file): file is File => file !== null);
}

export function filesFromDataTransfer(data: DataTransfer | null): File[] {
  if (!data) return [];
  return Array.from(data.files).filter((file) => kanbanMediaKindForFile(file) !== null);
}

export function toComposerMediaAttachment(file: File): ComposerImageAttachment | null {
  const kind = kanbanMediaKindForFile(file);
  if (!kind) return null;
  const id = `kanban-media-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return {
    type: "image",
    id,
    name: file.name || (kind === "image" ? "image" : "video"),
    mimeType: file.type || (kind === "image" ? "image/png" : "video/webm"),
    sizeBytes: file.size,
    previewUrl: URL.createObjectURL(file),
    file,
  };
}

export async function toKanbanUploadAttachments(
  images: ReadonlyArray<ComposerImageAttachment>,
): Promise<KanbanUploadCardAttachment[]> {
  const uploads: KanbanUploadCardAttachment[] = [];
  for (const image of images) {
    const kind = image.mimeType.toLowerCase().startsWith("video/") ? "video" : "image";
    const dataUrl = await readFileAsDataUrl(image.file);
    uploads.push({
      kind,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl,
    });
  }
  return uploads;
}

/** Send is allowed with text, media, or both. */
export function kanbanComposerHasSendableContent(input: {
  readonly prompt: string;
  readonly mediaCount: number;
}): boolean {
  return input.prompt.trim().length > 0 || input.mediaCount > 0;
}
