import type { CanvasSaveInput } from "@t3tools/contracts";

/**
 * The canvas's write-behind loop, with no tldraw and no React in it.
 *
 * Everything drawn on the canvas is persisted by debouncing the records the
 * editor reports as touched and sending them as a patch — or the whole document
 * when a patch would be a guess. The parts worth testing are the ones that only
 * show up when a write does not land: a rejected save has to come back, and a
 * canvas being torn down has to write what it is still holding.
 *
 * @module components/canvas/canvasSaveLoop
 */

/** Long enough that a drag is one save, short enough that a reload keeps it. */
export const SAVE_DEBOUNCE_MS = 1_500;

export interface CanvasSaveOutcome {
  readonly revision: number;
  readonly saved: boolean;
}

export interface CanvasSaveLoopOptions {
  /** Resolves null when the write failed outright; the loop retries either way. */
  readonly save: (input: CanvasSaveInput) => Promise<CanvasSaveOutcome | null>;
  /** The current value of one record, or undefined when it has been removed. */
  readonly readRecord: (id: string) => unknown;
  readonly snapshot: () => string;
  /** The revision the loaded document was at. */
  readonly revision: number;
  /** Someone else wrote first — the caller refetches so the tab can catch up. */
  readonly onConflict?: () => void;
  readonly debounceMs?: number;
}

export interface CanvasSaveLoop {
  readonly touch: (ids: Iterable<string>) => void;
  /** Write now, whatever the debounce says. */
  readonly flush: () => Promise<void>;
  /** Cancel the debounce, write what is still pending, and stop retrying. */
  readonly stop: () => Promise<void>;
}

export function createCanvasSaveLoop(options: CanvasSaveLoopOptions): CanvasSaveLoop {
  const debounceMs = options.debounceMs ?? SAVE_DEBOUNCE_MS;
  let touched = new Set<string>();
  let revision = options.revision;
  /**
   * Whether the server holds exactly what this loop last sent, which is the only
   * condition under which a partial write is correct. False after a load and
   * after any rejected save, so the next write is the whole document.
   */
  let patchable = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> = Promise.resolve();
  let stopped = false;

  const clear = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const schedule = (reset: boolean) => {
    if (stopped) return;
    if (timer !== null) {
      if (!reset) return;
      clear();
    }
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, debounceMs);
  };

  const runOnce = async () => {
    if (touched.size === 0 && patchable) return;
    const sending = touched;
    touched = new Set();

    // The edit, not the canvas: a stroke sends one record instead of everything
    // ever drawn. The whole document still goes out when a patch would be a
    // guess — the first save after a load, and after any rejection.
    let input: CanvasSaveInput;
    if (patchable) {
      const put: Record<string, unknown> = {};
      const removeIds: Array<string> = [];
      for (const id of sending) {
        const record = options.readRecord(id);
        if (record === undefined) removeIds.push(id);
        else put[id] = record;
      }
      input = { patch: { putJson: JSON.stringify(put), removeIds }, baseRevision: revision };
    } else {
      input = { snapshot: options.snapshot(), baseRevision: revision };
    }

    const result = await options.save(input).catch(() => null);
    if (result === null) {
      // Keeping the ids without re-arming the timer is how an edit disappears:
      // nothing else schedules a write, so the work sat here until the next
      // stroke — and a reload before that stroke lost it.
      for (const id of sending) touched.add(id);
      patchable = false;
      schedule(false);
      return;
    }
    revision = result.revision;
    if (result.saved) {
      patchable = true;
      return;
    }
    // Another tab wrote first, or the server could not merge the patch. Keep the
    // edits, take its revision rather than clobber it, and send the whole
    // document next time — the one write that cannot be wrong.
    for (const id of sending) touched.add(id);
    patchable = false;
    options.onConflict?.();
    schedule(false);
  };

  const flush = (): Promise<void> => {
    clear();
    running = running.then(runOnce, runOnce);
    return running;
  };

  return {
    touch: (ids) => {
      let added = false;
      for (const id of ids) {
        touched.add(id);
        added = true;
      }
      if (added) schedule(true);
    },
    flush,
    stop: () => {
      const pending = timer !== null || touched.size > 0;
      clear();
      const done = pending ? flush() : running;
      stopped = true;
      return done;
    },
  };
}
