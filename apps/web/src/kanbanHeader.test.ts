import { describe, expect, it } from "vite-plus/test";

/**
 * The header's StationMenu is the ONE navigation surface: a trigger that names
 * where you are, a menu of everywhere you can go — canvas, threads, frames.
 * This trips the build if anyone reintroduces a second one (the old
 * Board/Terminal/Canvas link row, or a separate frames dropdown), or puts the
 * word "Frames" back on screen as a place: a frame is named by what it shows,
 * never by what it is.
 */
describe("the kanban header stays one menu", () => {
  const sources = import.meta.glob("./routes/kanban.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  const source = Object.values(sources)[0] ?? "";

  const between = (from: string, to: string) => {
    const start = source.indexOf(from);
    const end = source.indexOf(to);
    expect(start, `${from} moved`).toBeGreaterThan(-1);
    expect(end, `${to} moved`).toBeGreaterThan(start);
    return source.slice(start, end);
  };

  it("reads the route source", () => {
    expect(source.length).toBeGreaterThan(0);
  });

  it("has no station link row and no separate frames menu", () => {
    expect(source).not.toContain("StationSwitcher");
    expect(source).not.toContain("FramesMenu");
  });

  it('never shows "Frames" as a place', () => {
    // Add groups its rows under "Frames" — a kind of thing to add. Where you
    // are is the other menu, and there a frame is named by what it shows.
    expect(between("function StationMenu(", "function AddMenu(")).not.toMatch(/\bFrames\b/);
  });
});
