/**
 * The rule that turns a screencast into paints: whatever arrived since the last
 * animation frame is drawn once, and everything before it is dropped.
 *
 * A page can produce frames faster than the display can show them, and every
 * frame the viewer decodes but never shows is pure cost — the old view decoded
 * each one into a Blob and an object URL first. Coalescing here means the cost
 * per frame is one string assignment, and the cost per *paint* is one decode.
 *
 * The scheduler is passed in so the loop can be tested without a browser.
 *
 * @module browser/browserFramePainter
 */

export interface FramePainterClock {
  readonly schedule: (paint: () => void) => number;
  readonly cancel: (handle: number) => void;
}

export interface FramePainter<TFrame> {
  /** Take a frame. Only the newest one survives to the next paint. */
  readonly offer: (frame: TFrame) => void;
  /** Drop anything pending and cancel a scheduled paint. */
  readonly stop: () => void;
}

export function createFramePainter<TFrame>(
  clock: FramePainterClock,
  paint: (frame: TFrame) => void,
): FramePainter<TFrame> {
  let pending: TFrame | null = null;
  let handle: number | null = null;

  const flush = () => {
    handle = null;
    const frame = pending;
    pending = null;
    if (frame !== null) paint(frame);
  };

  return {
    offer: (frame) => {
      pending = frame;
      if (handle !== null) return;
      handle = clock.schedule(flush);
    },
    stop: () => {
      pending = null;
      if (handle === null) return;
      clock.cancel(handle);
      handle = null;
    },
  };
}

/** The real one: the display's own clock. */
export const animationFrameClock: FramePainterClock = {
  schedule: (paint) => requestAnimationFrame(paint),
  cancel: (handle) => cancelAnimationFrame(handle),
};
