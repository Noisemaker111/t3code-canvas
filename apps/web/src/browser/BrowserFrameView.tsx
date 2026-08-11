import {
  agentBrowserFrameKey,
  latestAgentBrowserFrame,
  subscribeAgentBrowserFrames,
} from "@t3tools/client-runtime/state/agentBrowser";
import { useEffect, useRef } from "react";

import { animationFrameClock, createFramePainter } from "./browserFramePainter";

/**
 * The live page itself: one `<img>` the screencast paints into, and nothing
 * else.
 *
 * Every part of this is deliberate, because the version it replaces did the
 * opposite of each:
 *
 * - **No React state per frame.** Frames come from the painter's mailbox
 *   (`agentBrowserFrames`), not from the atom the chrome is drawn from, so a
 *   page painting continuously does not re-render the toolbar, the tab strip
 *   and the transcript beside it thirty times a second.
 * - **One frame per animation frame.** A screencast can outrun the display;
 *   whatever arrived since the last paint is one `src` assignment, and the
 *   frames in between are dropped rather than decoded.
 * - **A data URL, not a hand-rolled `atob`.** Decoding base64 in a JS loop, to
 *   a Uint8Array, to a Blob, to an object URL — per frame, plus the revoke —
 *   was the single most expensive thing on the client. The browser decodes a
 *   data URL in native code.
 */
export function BrowserFrameView({
  threadId,
  tabId,
  title,
  className,
}: {
  readonly threadId: string;
  readonly tabId: string;
  readonly title: string;
  readonly className?: string;
}) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const placeholderRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const key = agentBrowserFrameKey({ threadId, tabId });
    const painter = createFramePainter<string>(animationFrameClock, (data) => {
      const image = imageRef.current;
      if (image === null) return;
      image.src = `data:image/jpeg;base64,${data}`;
      // The placeholder is hidden by hand rather than by a state flip: the flip
      // would be a render, and this happens exactly once per attached tab.
      const placeholder = placeholderRef.current;
      if (placeholder !== null && placeholder.hidden === false) {
        placeholder.hidden = true;
        image.hidden = false;
      }
    });

    // A panel that mounts onto a tab already streaming draws immediately rather
    // than waiting out a frame interval on an empty box.
    const held = latestAgentBrowserFrame(key);
    if (held !== null) painter.offer(held.data);
    const unsubscribe = subscribeAgentBrowserFrames(key, (frame) => painter.offer(frame.data));
    return () => {
      unsubscribe();
      painter.stop();
    };
  }, [tabId, threadId]);

  return (
    <>
      <img
        ref={imageRef}
        alt={title}
        hidden
        draggable={false}
        decoding="async"
        className={className}
      />
      <div
        ref={placeholderRef}
        className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground"
      >
        <div className="size-8 animate-pulse rounded-full bg-muted" />
        Waiting for the first frame…
      </div>
    </>
  );
}
