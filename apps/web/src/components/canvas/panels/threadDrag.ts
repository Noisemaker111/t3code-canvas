/**
 * A thread dragged out of a list, and where it lands.
 *
 * The board's card drags ride dnd-kit because both ends are DOM inside one
 * context. This one has the canvas at the other end — you drag a thread row out
 * of a list and drop it on open canvas — so it rides the browser's own drag
 * transfer, which is the only thing both a panel's DOM and the tldraw surface
 * under it can see.
 *
 * @module components/canvas/panels/threadDrag
 */

/** Our own type, so a drop of anything else falls through to tldraw's handling. */
export const THREAD_DRAG_MIME = "application/x-t3-thread";

export function setThreadDragPayload(
  transfer: DataTransfer | null,
  threadId: string,
  title: string,
): void {
  if (transfer === null || threadId.length === 0) return;
  transfer.effectAllowed = "copy";
  transfer.setData(THREAD_DRAG_MIME, threadId);
  // A plain-text copy so the same drag can be dropped into the composer, a
  // terminal, or anything else that takes text.
  transfer.setData("text/plain", title);
}

/** The thread a drop is carrying, or null when it is carrying something else. */
export function threadIdFromDrop(transfer: DataTransfer | null): string | null {
  const id = transfer?.getData(THREAD_DRAG_MIME)?.trim() ?? "";
  return id.length === 0 ? null : id;
}

/** Whether a dragover is carrying a thread — what turns the drop zone on. */
export function isThreadDrag(transfer: DataTransfer | null): boolean {
  return transfer !== null && [...transfer.types].includes(THREAD_DRAG_MIME);
}
