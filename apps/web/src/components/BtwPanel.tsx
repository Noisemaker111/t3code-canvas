/**
 * BtwPanel — the "/btw" side-chat widget.
 *
 * A self-contained chat panel for talking to a model ABOUT the current coding
 * conversation. It is its own conversation: messages live in `btw_messages` on
 * the server and never enter the main thread, `conversation_log`, or the coding
 * agent's context. Replies stream token-by-token via the btw RPC.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { useBtwPanelStore, selectBtwPanelOpen, selectBtwThreadData } from "../btwPanelStore";
import { clearBtwMessages, loadBtwMessages, sendBtwMessage } from "../state/btw";
import { useAtomCommand } from "../state/use-atom-command";
import ChatMarkdown from "./ChatMarkdown";

export function BtwPanel({ threadRef }: { readonly threadRef: ScopedThreadRef | null }) {
  const isOpen = useBtwPanelStore((state) => selectBtwPanelOpen(state.openByThreadKey, threadRef));
  const data = useBtwPanelStore((state) => selectBtwThreadData(state.dataByThreadKey, threadRef));
  const close = useBtwPanelStore((state) => state.close);

  const runLoad = useAtomCommand(loadBtwMessages, { reportFailure: false });
  const runClear = useAtomCommand(clearBtwMessages, { reportFailure: false });
  const runSend = useAtomCommand(sendBtwMessage, { reportFailure: false });

  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (isOpen && threadRef && !data.loaded && !data.sending) {
      void runLoad({ ref: threadRef });
    }
  }, [isOpen, threadRef, data.loaded, data.sending, runLoad]);

  useEffect(() => {
    const element = listRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [data.messages]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!threadRef || text.length === 0 || data.sending) return;
    const store = useBtwPanelStore.getState();
    store.appendUser(threadRef, text);
    store.beginAssistant(threadRef);
    store.setSending(threadRef, true);
    setInput("");
    try {
      await runSend({ ref: threadRef, message: text });
    } catch {
      // Errors are reconciled from the store below.
    }
    const after = useBtwPanelStore.getState();
    const current = selectBtwThreadData(after.dataByThreadKey, threadRef);
    const last = current.messages[current.messages.length - 1];
    if (last?.role === "assistant" && last.streaming) {
      // The stream ended without an explicit `done` chunk (error/interrupt).
      after.finishAssistant(threadRef, last.content);
      if (last.content.length === 0) {
        after.setError(threadRef, "The btw chat reply failed. Please try again.");
      }
    }
    after.setSending(threadRef, false);
  }, [input, threadRef, data.sending, runSend]);

  if (!isOpen || !threadRef) return null;

  return (
    <div className="absolute inset-y-0 right-0 z-40 flex w-full max-w-[420px] flex-col border-l border-border bg-background shadow-xl">
      <div className="surface-subheader justify-between px-3">
        <span className="text-sm font-semibold text-foreground">/btw</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
            onClick={() => {
              if (threadRef) void runClear({ ref: threadRef });
            }}
            disabled={data.sending}
          >
            Clear
          </button>
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
            onClick={() => close(threadRef)}
            aria-label="Close btw panel"
          >
            ✕
          </button>
        </div>
      </div>

      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
        {data.messages.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Ask about the current coding conversation — e.g. “what did we change in the auth flow?”
            or “how many tokens did this conversation use?”
          </p>
        ) : (
          data.messages.map((message, index) => (
            <div
              key={index}
              className={
                message.role === "user"
                  ? "self-end rounded-lg bg-primary/10 px-3 py-2 text-sm"
                  : "self-start rounded-lg bg-muted px-3 py-2 text-sm"
              }
            >
              <ChatMarkdown
                text={message.content}
                cwd={undefined}
                isStreaming={Boolean(message.streaming)}
              />
            </div>
          ))
        )}
        {data.error ? <p className="text-xs text-destructive">{data.error}</p> : null}
      </div>

      <div className="border-t border-border p-2">
        <textarea
          className="min-h-[56px] w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
          placeholder="Message /btw…"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void handleSend();
            }
          }}
        />
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-foreground disabled:opacity-50"
            onClick={() => void handleSend()}
            disabled={data.sending || input.trim().length === 0}
          >
            {data.sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
