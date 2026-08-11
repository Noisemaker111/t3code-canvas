/** One-shot auto-send for board-created drafts (Active launch). */
export type BoardDraftSendOptions = {
  /** Force thread title on first send. */
  readonly forceTitle?: string;
};

const pending = new Map<string, BoardDraftSendOptions>();

export function requestBoardDraftAutoSend(
  draftId: string,
  options: BoardDraftSendOptions = {},
): void {
  pending.set(draftId, options);
}

export function consumeBoardDraftAutoSend(draftId: string): BoardDraftSendOptions | null {
  const options = pending.get(draftId);
  if (options === undefined) return null;
  pending.delete(draftId);
  return options;
}
