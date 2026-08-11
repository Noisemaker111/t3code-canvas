import { ImagePlusIcon, Loader2Icon, MicIcon, MicOffIcon, TerminalIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useCompactLayout } from "../canvas/panels/compactLayout";
import { HOST_ROOT_PATH, parseHostPrompt } from "./hostPrompt";
import { CAPTURE_BAR_HEIGHT_VAR } from "./KanbanBoard.logic";
import { shouldSubmitComposerOnEnter } from "../../composer-logic";
import {
  useComposerDraftStore,
  useComposerThreadDraft,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import { useComposerDictation } from "../../hooks/useComposerDictation";
import { useHostThreadLaunch } from "../../hooks/useHostThreadLaunch";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { readBoardSettings } from "../../lib/boardSettings";
import {
  nextPromptHistoryIndex,
  readStoredPromptHistory,
  recordSubmittedPrompt,
  subscribePromptHistory,
  subscribePromptHistoryReuse,
} from "../../lib/promptHistory";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useKanbanCards, useKanbanCommands } from "../../state/kanban";
import { type ComposerPromptEditorHandle, ComposerPromptEditor } from "../ComposerPromptEditor";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { describeCapturePickup } from "../../lib/hermesChip";
import { BoardModelPicker, useComposerModelPreset } from "./ComposerModelPreset";
import { KANBAN_COMPOSER_DRAFT_ID } from "./PromptHistoryButton";
import {
  acceptKanbanMediaFiles,
  filesFromClipboard,
  filesFromDataTransfer,
  kanbanComposerHasSendableContent,
  toComposerMediaAttachment,
  toKanbanUploadAttachments,
} from "./kanbanComposerMedia";

/**
 * Publish the capture bar's height so the board's own bottom-anchored status
 * pills can clear it. It grows with focus and with each attachment, so a fixed
 * offset either printed over the bar or floated well above it; only the one
 * capture bar standing on the window's bottom edge writes this.
 */
function useCaptureBarHeight(ref: React.RefObject<HTMLDivElement | null>, publish: boolean) {
  useEffect(() => {
    const node = ref.current;
    const root = document.documentElement;
    if (!publish || node === null) return;
    const observer = new ResizeObserver(() => {
      root.style.setProperty(CAPTURE_BAR_HEIGHT_VAR, `${Math.round(node.offsetHeight)}px`);
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      root.style.removeProperty(CAPTURE_BAR_HEIGHT_VAR);
    };
  }, [ref, publish]);
}

/**
 * Board capture. Composer text becomes a card; Hermes owns everything after
 * that (Settings → Hermes). `!` still opens a host thread directly.
 */
export function KanbanPageComposer({
  surface = "docked",
}: {
  /** `panel` when the composer is a panel's whole content, not a bar over one. */
  readonly surface?: "docked" | "panel";
} = {}) {
  const { environmentId, hermes, refresh } = useKanbanCards();
  const { createCard } = useKanbanCommands(environmentId);
  const { launch: launchHostThread } = useHostThreadLaunch();
  const [cursor, setCursor] = useState(0);
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const mediaInputRef = useRef<HTMLInputElement | null>(null);
  // Match ChatComposer: soft-keyboard surfaces use Return for newline + Send button.
  const isMobileViewport = useMediaQuery("max-sm");
  const compact = useCompactLayout();
  const [composerFocused, setComposerFocused] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [promptHistory, setPromptHistory] = useState<readonly string[]>(() =>
    readStoredPromptHistory(),
  );
  /** Shell-style ↑/↓ index into promptHistory; null when not cycling. */
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);

  const draft = useComposerThreadDraft(KANBAN_COMPOSER_DRAFT_ID);
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addImages = useComposerDraftStore((store) => store.addImages);
  const removeImage = useComposerDraftStore((store) => store.removeImage);
  const prompt = draft.prompt;
  const media = draft.images;

  useEffect(() => subscribePromptHistory(setPromptHistory), []);

  useEffect(
    () =>
      subscribePromptHistoryReuse((entry) => {
        setHistoryIndex(null);
        setCursor(entry.length);
      }),
    [],
  );

  const { preset, selection: presetSelection, setPreset } = useComposerModelPreset();

  const connected = environmentId !== null;

  const [captureInFlight, setCaptureInFlight] = useState(false);
  const hostPrompt = useMemo(() => parseHostPrompt(prompt), [prompt]);
  const [hostSendInFlight, setHostSendInFlight] = useState(false);
  const hasCaptureContent = kanbanComposerHasSendableContent({
    prompt,
    mediaCount: media.length,
  });
  const hostSubmitBlockedReason = !connected
    ? "Connect an environment before starting a host thread."
    : hostSendInFlight
      ? "Opening host thread…"
      : hostPrompt.text.length === 0
        ? "Type a task after ! first."
        : null;
  const captureSubmitBlockedReason = !connected
    ? "Connect an environment before capturing to the board."
    : captureInFlight
      ? "Saving the card…"
      : !hasCaptureContent
        ? "Type or attach something first."
        : null;
  const submitBlockedReason = hostPrompt.isHost
    ? hostSubmitBlockedReason
    : captureSubmitBlockedReason;
  const canSubmit = submitBlockedReason === null;

  const explainSubmitBlocked = useCallback(() => {
    if (!submitBlockedReason) return;
    toastManager.add({
      type: "error",
      title: "Can't send yet",
      description: submitBlockedReason,
    });
  }, [submitBlockedReason]);

  const addMediaFiles = useCallback(
    (files: File[]) => {
      const accepted = acceptKanbanMediaFiles({ files, currentCount: media.length });
      if (!accepted.ok) {
        toastManager.add({
          type: "error",
          title: "Couldn't attach that",
          description: accepted.error,
        });
        return;
      }
      const next = accepted.files
        .map((file) => toComposerMediaAttachment(file))
        .filter((entry): entry is ComposerImageAttachment => entry !== null);
      if (next.length > 0) addImages(KANBAN_COMPOSER_DRAFT_ID, next);
    },
    [addImages, media.length],
  );

  const removeMedia = useCallback(
    (imageId: string) => {
      const existing = media.find((entry) => entry.id === imageId);
      if (existing?.previewUrl.startsWith("blob:")) {
        URL.revokeObjectURL(existing.previewUrl);
      }
      removeImage(KANBAN_COMPOSER_DRAFT_ID, imageId);
    },
    [media, removeImage],
  );

  const handleHostSend = useCallback(() => {
    if (!canSubmit || environmentId === null) {
      explainSubmitBlocked();
      return;
    }
    const userText = hostPrompt.text;
    setHostSendInFlight(true);
    setPrompt(KANBAN_COMPOSER_DRAFT_ID, "");
    setCursor(0);
    setHistoryIndex(null);
    void (async () => {
      try {
        await launchHostThread({ text: userText });
        recordSubmittedPrompt(`! ${userText}`);
      } catch (error: unknown) {
        if (prompt.trim().length === 0) {
          setPrompt(KANBAN_COMPOSER_DRAFT_ID, `! ${userText}`);
        }
        toastManager.add({
          type: "error",
          title: "Could not start host thread",
          description:
            error instanceof Error
              ? error.message
              : `Failed to open a thread at ${HOST_ROOT_PATH}.`,
        });
      } finally {
        setHostSendInFlight(false);
      }
    })();
  }, [
    canSubmit,
    environmentId,
    explainSubmitBlocked,
    hostPrompt.text,
    launchHostThread,
    prompt,
    setPrompt,
  ]);

  /**
   * Board capture: the composer writes a card and stops. Hermes reads it on
   * its next tick — see Settings → Hermes. The `!` host thread is unchanged.
   */
  const handleCaptureSend = useCallback(() => {
    if (!canSubmit) {
      explainSubmitBlocked();
      return;
    }
    const userText = prompt.trim();
    const mediaSnapshot = [...media];
    if ((!userText && mediaSnapshot.length === 0) || environmentId === null) return;

    setCaptureInFlight(true);
    setPrompt(KANBAN_COMPOSER_DRAFT_ID, "");
    setCursor(0);
    setHistoryIndex(null);
    for (const entry of mediaSnapshot) {
      removeImage(KANBAN_COMPOSER_DRAFT_ID, entry.id);
    }
    void (async () => {
      try {
        const boardSettings = readBoardSettings();
        const firstLine = userText.split("\n")[0]?.trim() ?? userText;
        const titleFromMedia =
          mediaSnapshot.length === 1
            ? `Media: ${mediaSnapshot[0]?.name ?? "attachment"}`
            : mediaSnapshot.length > 1
              ? `Media: ${mediaSnapshot.length} attachments`
              : "Untitled task";
        const uploads =
          mediaSnapshot.length > 0 ? await toKanbanUploadAttachments(mediaSnapshot) : undefined;
        const result = await createCard({
          title: (firstLine.slice(0, 120) || titleFromMedia).slice(0, 120),
          body: userText,
          at: "prompts",
          ...(presetSelection ? { modelSelection: presetSelection } : {}),
          ...(uploads && uploads.length > 0 ? { attachments: uploads } : {}),
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        if (userText.length > 0) recordSubmittedPrompt(userText);
        for (const entry of mediaSnapshot) {
          if (entry.previewUrl.startsWith("blob:")) URL.revokeObjectURL(entry.previewUrl);
        }
        refresh();
        toastManager.add({
          type: "success",
          title: "Captured to the board",
          description: describeCapturePickup(hermes),
        });
      } catch (error) {
        setPrompt(KANBAN_COMPOSER_DRAFT_ID, userText);
        if (mediaSnapshot.length > 0) addImages(KANBAN_COMPOSER_DRAFT_ID, mediaSnapshot);
        toastManager.add({
          type: "error",
          title: "Could not capture that",
          description: error instanceof Error ? error.message : "Failed to create the card.",
        });
      } finally {
        setCaptureInFlight(false);
      }
    })();
  }, [
    addImages,
    canSubmit,
    createCard,
    environmentId,
    explainSubmitBlocked,
    hermes,
    media,
    presetSelection,
    prompt,
    refresh,
    removeImage,
    setPrompt,
  ]);

  const handleSend = useCallback(() => {
    if (hostPrompt.isHost) {
      handleHostSend();
      return;
    }
    handleCaptureSend();
  }, [handleCaptureSend, handleHostSend, hostPrompt.isHost]);

  const onPromptChange = useCallback(
    (
      nextValue: string,
      nextCursor: number,
      _expandedCursor: number,
      _cursorAdjacentToMention: boolean,
      _terminalContextIds: string[],
    ) => {
      setHistoryIndex(null);
      setPrompt(KANBAN_COMPOSER_DRAFT_ID, nextValue);
      setCursor(nextCursor);
    },
    [setPrompt],
  );

  const applyDictatedPrompt = useCallback(
    (nextValue: string, nextCursor: number) => {
      setHistoryIndex(null);
      setPrompt(KANBAN_COMPOSER_DRAFT_ID, nextValue);
      setCursor(nextCursor);
      editorRef.current?.focusAtEnd();
    },
    [setPrompt],
  );

  const dictation = useComposerDictation({
    disabled: !connected || captureInFlight || hostSendInFlight,
    prompt,
    onPromptChange: applyDictatedPrompt,
    onError: (message) => {
      toastManager.add({ type: "error", title: "Dictation failed", description: message });
    },
  });

  const applyHistoryEntry = useCallback(
    (index: number | null) => {
      setHistoryIndex(index);
      if (index === null) {
        setPrompt(KANBAN_COMPOSER_DRAFT_ID, "");
        setCursor(0);
        return;
      }
      const entry = promptHistory[index];
      if (entry === undefined) return;
      setPrompt(KANBAN_COMPOSER_DRAFT_ID, entry);
      setCursor(entry.length);
    },
    [promptHistory, setPrompt],
  );

  const onCommandKeyDown = useCallback(
    (key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab", event: KeyboardEvent) => {
      if (key === "ArrowUp" || key === "ArrowDown") {
        const cycling = historyIndex !== null;
        const empty = prompt.trim().length === 0;
        if (!cycling && !empty) return false;
        if (promptHistory.length === 0) return false;
        const nextIndex = nextPromptHistoryIndex(
          promptHistory.length,
          historyIndex,
          key === "ArrowUp" ? "older" : "newer",
        );
        if (nextIndex === historyIndex) return true;
        applyHistoryEntry(nextIndex);
        return true;
      }
      if (key !== "Enter") return false;
      if (
        !shouldSubmitComposerOnEnter({
          isMobileViewport,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
        })
      ) {
        return false;
      }
      if (!canSubmit) {
        explainSubmitBlocked();
        return true;
      }
      handleSend();
      return true;
    },
    [
      applyHistoryEntry,
      canSubmit,
      explainSubmitBlocked,
      handleSend,
      historyIndex,
      isMobileViewport,
      prompt,
      promptHistory.length,
    ],
  );

  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLElement>) => {
      if (hostPrompt.isHost) return;
      const pasted = filesFromClipboard(event.clipboardData);
      if (pasted.length === 0) return;
      event.preventDefault();
      addMediaFiles(pasted);
    },
    [addMediaFiles, hostPrompt.isHost],
  );

  // Collapsed until it is being used: expanded, this box was a third of a phone
  // screen parked over the column it captures into, and the archive target
  // underneath it was unreachable.
  const collapsed = compact && !composerFocused && prompt.trim().length === 0 && media.length === 0;

  const barRef = useRef<HTMLDivElement | null>(null);
  useCaptureBarHeight(barRef, compact);

  const sendButton = (
    <button
      type="button"
      aria-label={
        canSubmit
          ? hostPrompt.isHost
            ? "Open host thread"
            : "Capture to the board"
          : "Can't send yet"
      }
      title={
        submitBlockedReason ??
        (isMobileViewport
          ? "Send (Return adds a new line)"
          : "Send (Enter). Shift+Enter for a new line")
      }
      aria-disabled={!canSubmit}
      onClick={() => {
        if (!canSubmit) {
          explainSubmitBlocked();
          return;
        }
        handleSend();
      }}
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-all duration-150",
        canSubmit
          ? "bg-primary/90 text-primary-foreground shadow-xs shadow-primary/20 hover:bg-primary hover:scale-[1.02] active:scale-[0.98]"
          : "bg-muted/60 text-muted-foreground/50 hover:bg-muted",
      )}
    >
      {(hostPrompt.isHost ? hostSendInFlight : captureInFlight) ? (
        <Loader2Icon className="size-3.5 animate-spin" />
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );

  const attachButton = !hostPrompt.isHost ? (
    <button
      type="button"
      aria-label="Attach image or video"
      title="Attach image or video"
      disabled={!connected || captureInFlight || dictation.busy || dictation.recording}
      onClick={() => mediaInputRef.current?.click()}
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
    >
      <ImagePlusIcon className="size-3.5" aria-hidden />
    </button>
  ) : null;

  const micButton = (
    <Button
      type="button"
      variant={dictation.recording ? "default" : "ghost"}
      size="icon-xs"
      className={cn(
        "shrink-0 rounded-full",
        dictation.recording && "bg-destructive text-white hover:bg-destructive/90",
      )}
      aria-label={dictation.ariaLabel}
      title={dictation.title}
      aria-pressed={dictation.recording}
      disabled={!connected || dictation.busy || captureInFlight || hostSendInFlight}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => dictation.toggle()}
    >
      {dictation.busy ? (
        <Loader2Icon className="size-3.5 animate-spin" />
      ) : dictation.recording ? (
        <MicOffIcon className="size-3.5" />
      ) : (
        <MicIcon className="size-3.5" />
      )}
    </Button>
  );

  return (
    <div
      ref={barRef}
      className={cn(
        "pointer-events-none z-20",
        surface === "panel"
          ? "absolute inset-0 flex flex-col justify-center px-3"
          : "absolute inset-x-0 bottom-0 px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5",
      )}
    >
      <form
        className={cn(
          "pointer-events-auto mx-auto flex w-full gap-2",
          // Docked over the board it is a bar floating on its own surface; as a
          // panel of its own the panel already is that surface, so it draws
          // none of its own.
          surface === "panel"
            ? "max-w-3xl py-3"
            : "max-w-3xl rounded-2xl bg-raised p-3 backdrop-blur-md has-focus-within:ring-2 has-focus-within:ring-ring/30",
          collapsed ? "items-end p-2" : "flex-col",
          !connected && "opacity-75",
          dragOver && surface !== "panel" && "ring-2 ring-ring/60 bg-accent",
        )}
        onFocusCapture={() => setComposerFocused(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setComposerFocused(false);
        }}
        onDragEnter={(event) => {
          if (hostPrompt.isHost) return;
          if (event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            setDragOver(true);
          }
        }}
        onDragOver={(event) => {
          if (hostPrompt.isHost) return;
          if (event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setDragOver(true);
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDragOver(false);
          }
        }}
        onDrop={(event) => {
          if (hostPrompt.isHost) return;
          event.preventDefault();
          setDragOver(false);
          const dropped = filesFromDataTransfer(event.dataTransfer);
          if (dropped.length > 0) addMediaFiles(dropped);
        }}
        onSubmit={(event) => {
          event.preventDefault();
          handleSend();
        }}
      >
        <input
          ref={mediaInputRef}
          type="file"
          accept="image/*,video/*"
          multiple
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (files.length > 0) addMediaFiles(files);
          }}
        />

        {media.length > 0 && !collapsed ? (
          <ul className="flex flex-wrap gap-2" aria-label="Attached media">
            {media.map((entry) => {
              const isVideo = entry.mimeType.toLowerCase().startsWith("video/");
              return (
                <li
                  key={entry.id}
                  className="relative size-16 overflow-hidden rounded-lg border border-border bg-muted/40"
                >
                  {isVideo ? (
                    <video
                      src={entry.previewUrl}
                      className="size-full object-cover"
                      muted
                      playsInline
                      aria-label={entry.name}
                    />
                  ) : (
                    <img
                      src={entry.previewUrl}
                      alt={entry.name}
                      className="size-full object-cover"
                    />
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${entry.name}`}
                    onClick={() => removeMedia(entry.id)}
                    className="absolute right-0.5 top-0.5 inline-flex size-5 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm"
                  >
                    <XIcon className="size-3" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}

        <div className={cn(collapsed && "min-w-0 flex-1")}>
          <ComposerPromptEditor
            {...(collapsed ? { className: "min-h-8 max-h-24 py-1" } : {})}
            editorRef={editorRef}
            value={prompt}
            cursor={cursor}
            terminalContexts={[]}
            skills={[]}
            onRemoveTerminalContext={() => {}}
            onChange={onPromptChange}
            onCommandKeyDown={onCommandKeyDown}
            onPaste={onPaste}
            placeholder={
              connected
                ? collapsed
                  ? "Capture to the board…"
                  : "Rambling is fine… attach images/videos if needed (! for a host thread)"
                : "Connect an environment…"
            }
            disabled={!connected}
          />
        </div>

        {collapsed ? (
          <div className="flex shrink-0 items-center gap-1">
            {attachButton}
            {sendButton}
          </div>
        ) : null}

        {hostPrompt.isHost && !collapsed ? (
          <p
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <TerminalIcon className="size-3.5 shrink-0" aria-hidden />
            Host thread — opens a chat at {HOST_ROOT_PATH} with no worktree, skipping the board.
          </p>
        ) : null}

        {submitBlockedReason && hasCaptureContent && !captureInFlight ? (
          <p className="text-xs text-amber-600 dark:text-amber-400" role="status">
            {submitBlockedReason}
          </p>
        ) : null}

        {collapsed ? null : (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            <BoardModelPicker
              preset={preset}
              onChange={setPreset}
              disabled={!connected || dictation.busy || dictation.recording}
              triggerClassName="mr-auto"
            />
            {micButton}
            {attachButton}
            {sendButton}
          </div>
        )}
      </form>
    </div>
  );
}
