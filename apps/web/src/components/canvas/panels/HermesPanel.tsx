import type { HermesChatEntry } from "@t3tools/contracts";
import {
  ChevronRightIcon,
  Loader2Icon,
  MicIcon,
  MicOffIcon,
  SendHorizonalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCanvasCommands, useCanvasMessages } from "../../../state/canvas";
import { useProjects } from "../../../state/entities";
import { usePrimaryEnvironment } from "../../../state/environments";
import { useKanbanCards } from "../../../state/kanban";
import { useComposerDictation } from "../../../hooks/useComposerDictation";
import { configureHermesBrain, fetchHermesChat } from "../../../lib/hermesBrain";
import { mergeHermesFeed, type HermesFeedRow } from "../../../lib/hermesChatFeed";
import { buildPanelTree, type PanelTreeItem } from "../../../lib/hermesPanelTree";
import { useNowMs } from "../../../lib/useNowMs";
import { ScrollArea } from "../../ui/scroll-area";
import { Switch } from "../../ui/switch";
import { useCompactLayout } from "./compactLayout";
import { cn } from "~/lib/utils";

const CHAT_POLL_MS = 3_000;
const EMPTY_ENTRIES: ReadonlyArray<HermesChatEntry> = [];

/** The durable Hermes feed, polled. Its own state: nothing else reads it. */
function useHermesChat() {
  const [entries, setEntries] = useState(EMPTY_ENTRIES);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetchHermesChat().then(
      (result) => {
        setEntries(result.entries);
        setError(null);
      },
      (cause: Error) => setError(cause.message),
    );
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, CHAT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { entries, error, refresh };
}

function secondsUntil(nextTickAt: string | null, nowMs: number): number | null {
  if (nextTickAt === null) return null;
  const seconds = Math.round((Date.parse(nextTickAt) - nowMs) / 1000);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : null;
}

/** "x-ai/grok-4.5" or the bare ACP id "grok-4.5" → "Grok 4.5" — nobody
 * reading the panel cares which provider slug it came through. */
function prettyModelLabel(model: string): string {
  const base = model.includes("/") ? (model.split("/").pop() ?? model) : model;
  return base
    .split("-")
    .map((part) => (/^[a-z]+$/i.test(part) ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

/** `PR #196` and the board column a card was moved to — the two things a line
 * says that are worth finding without reading the sentence. */
const PILL_PATTERN = /(PR #\d+|moved to (?:Prompts|Active|PR|Done))/g;

function Pill({ text }: { readonly text: string }) {
  const done = text.startsWith("moved to");
  return (
    <span
      className={cn(
        "mx-0.5 inline-flex items-center rounded px-1.5 py-px align-baseline text-[10px] font-semibold whitespace-nowrap",
        done
          ? "bg-success/15 text-success"
          : "bg-primary/15 text-primary dark:bg-primary/25 dark:text-primary-foreground",
      )}
    >
      {done ? text.slice("moved to ".length) : text}
    </span>
  );
}

function SummaryText({ summary }: { readonly summary: string }) {
  return (
    <>
      {summary.split(PILL_PATTERN).map((part, index) =>
        index % 2 === 1 ? (
          // eslint-disable-next-line react/no-array-index-key -- split parts have no identity of their own
          <Pill key={index} text={part} />
        ) : (
          // eslint-disable-next-line react/no-array-index-key -- same
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

/** One line under a project/card, or standing alone when it names no live card. */
function TreeLine({
  row,
  alert,
  summary,
}: {
  readonly row: HermesFeedRow;
  readonly alert: boolean;
  readonly summary: string;
}) {
  const [open, setOpen] = useState(false);
  const expandable = row.text.length > 0 || row.program !== undefined;

  return (
    <div>
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left text-xs leading-snug",
          "disabled:cursor-default",
          alert ? "font-semibold text-destructive" : "text-foreground",
        )}
      >
        {alert ? (
          <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
        ) : (
          <span className="mt-0.5 w-3 shrink-0 text-center text-muted-foreground">–</span>
        )}
        <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">
          <SummaryText summary={summary} />
        </span>
        {expandable ? (
          <ChevronRightIcon
            className={cn("mt-0.5 size-3 shrink-0 text-muted-foreground", open && "rotate-90")}
          />
        ) : null}
      </button>
      {open && row.text.length > 0 ? (
        <pre className="mt-1 ml-4 max-h-72 overflow-auto rounded bg-muted/50 p-2 text-[10px] leading-snug whitespace-pre-wrap text-muted-foreground">
          {row.text}
        </pre>
      ) : null}
      {open && row.program !== undefined ? (
        <pre className="mt-1 ml-4 max-h-72 overflow-auto rounded bg-muted/50 p-2 font-mono text-[10px] leading-snug text-muted-foreground">
          {row.program}
        </pre>
      ) : null}
    </div>
  );
}

function TreeItemView({ item }: { readonly item: PanelTreeItem }) {
  switch (item.type) {
    case "project":
      return (
        <p
          className={cn("mt-3 flex items-center gap-2 px-1 text-[13px] font-bold", item.colorClass)}
        >
          <span className="size-2.5 shrink-0 rounded-[3px] border-[1.5px] border-current" />
          {item.title}
        </p>
      );
    case "card":
      return (
        <p className="mt-1.5 ml-4 flex items-center gap-2 px-1 text-xs font-semibold text-foreground">
          <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />
          <span className="min-w-0 break-words">{item.title}</span>
          {item.prNumber !== null ? <Pill text={`PR #${item.prNumber}`} /> : null}
        </p>
      );
    case "action":
      return (
        <div className="ml-8">
          <TreeLine row={item.row} alert={item.row.error !== undefined} summary={item.summary} />
        </div>
      );
    case "standalone":
      return (
        <div className="flex items-baseline gap-2.5 border-l-2 border-primary/60 px-2.5 py-1 text-[13px] leading-snug text-foreground">
          <span className="min-w-0 flex-1 break-words">
            <SummaryText summary={item.row.summary} />
          </span>
          {item.repeat > 1 ? (
            <span className="shrink-0 text-[11px] font-semibold text-muted-foreground tabular-nums">
              ×{item.repeat}
            </span>
          ) : null}
        </div>
      );
    case "you":
      return (
        <div className="ml-auto flex max-w-[85%] flex-col items-end gap-0.5">
          {/* max-w-full or the bubble takes its content's width: `items-end`
              aligns a block, it does not constrain one, so a message with a
              long unbroken run in it — a stack trace, a URL — grew past the
              85% and out of the panel's left edge on a phone. */}
          <div className="max-w-full rounded-2xl rounded-br-sm bg-accent px-3 py-1.5 text-[13px] leading-snug break-words text-accent-foreground">
            {item.row.summary}
          </div>
        </div>
      );
    case "thread":
      return (
        <p className="px-1 text-xs text-muted-foreground italic">
          {item.row.label}: {item.row.summary}
        </p>
      );
  }
}

/** The feed itself, given a built tree — the part that renders without a board
 * behind it. */
export function HermesTreeView({ items }: { readonly items: ReadonlyArray<PanelTreeItem> }) {
  return (
    <div className="flex flex-col gap-1 p-3">
      {items.map((item, index) => (
        // eslint-disable-next-line react/no-array-index-key -- the tree is rebuilt whole on every poll
        <TreeItemView key={index} item={item} />
      ))}
    </div>
  );
}

/**
 * The Hermes conversation, parked next to the board it drives.
 *
 * Grouped project → card → action, oldest first — Hermes's own summaries
 * already name the card they concern, so the tree needs no extra plumbing
 * from the tick recorder. What you type joins the same feed and wakes the
 * loop to read it.
 */
export function HermesPanel() {
  const primaryEnvironment = usePrimaryEnvironment();
  const commands = useCanvasCommands(primaryEnvironment?.environmentId ?? null);
  const { messages, refresh: refreshMessages } = useCanvasMessages();
  const { entries, error, refresh: refreshChat } = useHermesChat();
  const { hermes, cards } = useKanbanCards();
  const projects = useProjects();
  const nowMs = useNowMs(1_000);
  const compact = useCompactLayout();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [dictationError, setDictationError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const dictation = useComposerDictation({
    disabled: sending,
    prompt: text,
    onPromptChange: (next) => setText(next),
    onError: (message) => setDictationError(message),
  });

  useEffect(() => {
    if (dictationError === null) return;
    const timer = window.setTimeout(() => setDictationError(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [dictationError]);

  const rows = useMemo(() => mergeHermesFeed({ messages, entries }), [messages, entries]);
  const projectTitleById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.title] as const)),
    [projects],
  );
  const tree = useMemo(
    () => buildPanelTree(rows, cards, projectTitleById),
    [rows, cards, projectTitleById],
  );

  useEffect(() => {
    const timer = window.setInterval(refreshMessages, 10_000);
    return () => window.clearInterval(timer);
  }, [refreshMessages]);

  // Only when you are already at the bottom: a poll that yanks you out of the
  // turn you are reading is worse than a feed that waits.
  useEffect(() => {
    const anchor = bottomRef.current;
    const viewport = anchor?.closest("[data-slot=scroll-area-viewport]");
    if (!anchor) return;
    if (
      viewport instanceof HTMLElement &&
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 96
    ) {
      return;
    }
    anchor.scrollIntoView({ block: "end" });
  }, [tree.length]);

  const enabled = pendingEnabled ?? hermes?.enabled ?? false;
  const countdown = hermes ? secondsUntil(hermes.nextTickAt, nowMs) : null;

  /** The switch answers the click, not the round trip; a failure snaps it back. */
  const setEnabled = useCallback((checked: boolean) => {
    setPendingEnabled(checked);
    setToggleBusy(true);
    configureHermesBrain({ enabled: checked })
      .catch(() => undefined)
      .finally(() => {
        setPendingEnabled(null);
        setToggleBusy(false);
      });
  }, []);

  const send = async () => {
    const body = text.trim();
    if (body.length === 0 || sending) return;
    setSending(true);
    await commands
      .postMessage({ authorKind: "human", target: "hermes", text: body })
      .catch(() => undefined);
    setSending(false);
    setText("");
    refreshMessages();
    refreshChat();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-2">
          {hermes ? (
            <span className="rounded-full border border-accent/40 bg-accent/15 px-2 py-0.5 text-[11px] font-semibold text-accent-foreground">
              {prettyModelLabel(hermes.model)}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2.5">
          {hermes ? (
            <span className="flex items-center gap-1.5 font-mono text-[11px]">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  enabled ? "animate-pulse bg-success" : "bg-muted-foreground",
                )}
              />
              <span className="font-semibold text-foreground tabular-nums">
                {enabled && countdown !== null ? `${countdown}s` : "off"}
              </span>
            </span>
          ) : null}
          <Switch
            checked={enabled}
            disabled={toggleBusy}
            onCheckedChange={setEnabled}
            aria-label="Turn Hermes on or off"
          />
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {tree.length === 0 ? (
          <p className="p-3 text-[11px] text-muted-foreground">
            {error === null
              ? "Nothing yet. Hermes writes here every time it reads the board."
              : `Chat unavailable: ${error}`}
          </p>
        ) : (
          <HermesTreeView items={tree} />
        )}
        <div ref={bottomRef} />
      </ScrollArea>

      {dictationError !== null ? (
        <p className="shrink-0 px-3 pt-2 text-[11px] text-destructive">{dictationError}</p>
      ) : null}

      <form
        className="flex shrink-0 items-end border-t border-border/60 p-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="relative flex min-w-0 flex-1 items-end rounded-xl bg-raised py-2 pr-1.5 pl-3 focus-within:ring-2 focus-within:ring-ring/35">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              // A soft keyboard's Return is a newline, not a send: the phone has
              // no Shift+Enter and the Send button is right there.
              if (event.key === "Enter" && !event.shiftKey && !compact) {
                event.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder="Say something to Hermes…"
            // 16px on a phone, or iOS zooms the whole page in on focus and leaves
            // the panel scrolled off its own screen. Right padding keeps text
            // from running under the mic/send buttons docked in this corner.
            className="max-h-32 min-h-5 w-full resize-none border-none bg-transparent pr-16 text-base outline-none sm:text-[13.5px]"
          />
          <div className="absolute right-1.5 bottom-1.5 flex items-center gap-1">
            <button
              type="button"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => dictation.toggle()}
              disabled={sending}
              aria-pressed={dictation.recording}
              aria-label={dictation.ariaLabel}
              title={dictation.title}
              className={cn(
                "inline-flex size-7 shrink-0 items-center justify-center rounded-lg transition",
                dictation.recording
                  ? "bg-destructive text-white hover:bg-destructive/90"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
                "disabled:opacity-40",
              )}
            >
              {dictation.busy ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : dictation.recording ? (
                <MicOffIcon className="size-3.5" />
              ) : (
                <MicIcon className="size-3.5" />
              )}
            </button>
            <button
              type="submit"
              disabled={sending || text.trim().length === 0}
              className={cn(
                "inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground",
                "transition hover:brightness-110 active:scale-95 disabled:opacity-40 disabled:hover:brightness-100",
              )}
              aria-label="Send to Hermes"
            >
              <SendHorizonalIcon className="size-3.5" />
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
