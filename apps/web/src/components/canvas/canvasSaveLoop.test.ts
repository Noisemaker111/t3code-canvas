import type { CanvasSaveInput } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createCanvasSaveLoop, type CanvasSaveOutcome } from "./canvasSaveLoop";

const DEBOUNCE = 10;

function harness(answers: Array<CanvasSaveOutcome | null>) {
  const sent: Array<CanvasSaveInput> = [];
  const conflicts: Array<number> = [];
  const records = new Map<string, unknown>([["shape:a", { id: "shape:a", typeName: "shape" }]]);
  const loop = createCanvasSaveLoop({
    revision: 3,
    debounceMs: DEBOUNCE,
    readRecord: (id) => records.get(id),
    snapshot: () => '{"document":{}}',
    onConflict: () => conflicts.push(sent.length),
    save: (input) => {
      sent.push(input);
      const answer = answers.length > 0 ? answers.shift() : { revision: 99, saved: true };
      return Promise.resolve(answer ?? null);
    },
  });
  return { loop, sent, conflicts, records };
}

/** Let the debounce fire and every chained save settle. */
async function settle(times = 1) {
  for (let round = 0; round < times; round += 1) {
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    await vi.advanceTimersByTimeAsync(0);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createCanvasSaveLoop", () => {
  it("sends the whole document first, then patches", async () => {
    const { loop, sent } = harness([
      { revision: 4, saved: true },
      { revision: 5, saved: true },
    ]);
    loop.touch(["shape:a"]);
    await settle();
    expect(sent[0]?.snapshot).toBeDefined();
    expect(sent[0]?.baseRevision).toBe(3);

    loop.touch(["shape:a"]);
    await settle();
    expect(sent[1]?.patch).toBeDefined();
    expect(sent[1]?.baseRevision).toBe(4);
  });

  it("sends a removed record as a removal", async () => {
    const { loop, sent, records } = harness([{ revision: 4, saved: true }]);
    loop.touch(["shape:a"]);
    await settle();
    records.delete("shape:a");
    loop.touch(["shape:a"]);
    await settle();
    expect(sent[1]?.patch?.removeIds).toEqual(["shape:a"]);
  });

  // The bug: a rejected write kept the edits but nothing re-armed the timer, so
  // a move or a delete sat unsent until the next stroke and a reload lost it.
  it("retries after a failed write", async () => {
    const { loop, sent } = harness([null, { revision: 4, saved: true }]);
    loop.touch(["shape:a"]);
    await settle();
    expect(sent).toHaveLength(1);
    await settle();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.snapshot).toBeDefined();
  });

  it("retries after a conflict, as a whole document, on the server's revision", async () => {
    const { loop, sent, conflicts } = harness([
      { revision: 4, saved: true },
      { revision: 12, saved: false },
      { revision: 13, saved: true },
    ]);
    loop.touch(["shape:a"]);
    await settle();
    loop.touch(["shape:a"]);
    await settle();
    expect(sent[1]?.patch).toBeDefined();
    expect(conflicts).toEqual([2]);

    await settle();
    expect(sent).toHaveLength(3);
    expect(sent[2]?.snapshot).toBeDefined();
    expect(sent[2]?.baseRevision).toBe(12);
  });

  // Navigating away or unmounting inside the debounce window used to drop the
  // pending timer without writing it.
  it("writes what it is still holding when it stops", async () => {
    const { loop, sent } = harness([{ revision: 4, saved: true }]);
    loop.touch(["shape:a"]);
    await loop.stop();
    expect(sent).toHaveLength(1);
  });

  it("stops retrying once stopped", async () => {
    const { loop, sent } = harness([null]);
    loop.touch(["shape:a"]);
    await loop.stop();
    expect(sent).toHaveLength(1);
    await settle(3);
    expect(sent).toHaveLength(1);
  });

  it("does not write when nothing was touched", async () => {
    const { loop, sent } = harness([]);
    await loop.stop();
    expect(sent).toHaveLength(0);
  });

  it("coalesces a burst into one write", async () => {
    const { loop, sent } = harness([{ revision: 4, saved: true }]);
    loop.touch(["shape:a"]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
    loop.touch(["shape:b"]);
    await settle();
    expect(sent).toHaveLength(1);
  });
});
