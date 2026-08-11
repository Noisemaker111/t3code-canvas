import { describe, expect, it } from "vite-plus/test";

import { createFramePainter, type FramePainterClock } from "./browserFramePainter";

function testClock() {
  const queued: Array<() => void> = [];
  let next = 1;
  const handles = new Map<number, () => void>();
  const clock: FramePainterClock = {
    schedule: (paint) => {
      const handle = next++;
      handles.set(handle, paint);
      queued.push(paint);
      return handle;
    },
    cancel: (handle) => {
      const paint = handles.get(handle);
      handles.delete(handle);
      const index = paint === undefined ? -1 : queued.indexOf(paint);
      if (index >= 0) queued.splice(index, 1);
    },
  };
  return {
    clock,
    tick: () => {
      const due = [...queued];
      queued.length = 0;
      for (const paint of due) paint();
    },
  };
}

describe("createFramePainter", () => {
  it("paints the newest frame once per tick and drops the rest", () => {
    const { clock, tick } = testClock();
    const painted: Array<string> = [];
    const painter = createFramePainter<string>(clock, (frame) => painted.push(frame));
    painter.offer("one");
    painter.offer("two");
    painter.offer("three");
    expect(painted).toEqual([]);
    tick();
    expect(painted).toEqual(["three"]);
  });

  it("paints again on the next tick, and not at all while idle", () => {
    const { clock, tick } = testClock();
    const painted: Array<string> = [];
    const painter = createFramePainter<string>(clock, (frame) => painted.push(frame));
    painter.offer("one");
    tick();
    tick();
    painter.offer("two");
    tick();
    expect(painted).toEqual(["one", "two"]);
  });

  it("paints nothing after it stops", () => {
    const { clock, tick } = testClock();
    const painted: Array<string> = [];
    const painter = createFramePainter<string>(clock, (frame) => painted.push(frame));
    painter.offer("one");
    painter.stop();
    tick();
    expect(painted).toEqual([]);
  });
});
