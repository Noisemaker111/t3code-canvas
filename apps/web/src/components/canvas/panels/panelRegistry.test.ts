import { describe, expect, it } from "@effect/vitest";

import {
  ADDABLE_PANEL_KINDS,
  isPanelClosable,
  PANEL_KINDS,
  panelSize,
  PANEL_MANIFESTS,
  PANEL_SIZE,
  panelCloseAction,
  panelManifest,
} from "./panelRegistry";
import { desiredStations } from "./panelStations";

describe("PANEL_MANIFESTS", () => {
  it("has one manifest per kind, keyed by its own kind", () => {
    for (const kind of PANEL_KINDS) {
      expect(panelManifest(kind).kind).toBe(kind);
    }
    expect(Object.keys(PANEL_MANIFESTS).length).toBe(PANEL_KINDS.length);
  });

  it("never declares a minimum bigger than the size it opens at", () => {
    for (const kind of PANEL_KINDS) {
      const { size, minSize } = panelManifest(kind);
      expect(minSize.w).toBeLessThanOrEqual(size.w);
      expect(minSize.h).toBeLessThanOrEqual(size.h);
    }
  });

  // `minSize` is the unit the zoom ladder measures in (`panelTiers`), so a zero
  // there is a panel that is never too small to render.
  it("declares a positive readable minimum for every kind", () => {
    for (const kind of PANEL_KINDS) {
      const { minSize } = panelManifest(kind);
      expect(minSize.w).toBeGreaterThan(0);
      expect(minSize.h).toBeGreaterThan(0);
    }
  });

  it("exposes the authored sizes as PANEL_SIZE", () => {
    for (const kind of PANEL_KINDS) {
      expect(PANEL_SIZE[kind]).toEqual(panelManifest(kind).size);
    }
  });

  // Force-present and reapable are the two ways the reconciler touches a panel
  // without being asked, and a kind the reconciler *always* wants must not also
  // be reapable — it would be created and deleted on every pass forever.
  //
  // A kind whose presence follows data may be both. The columns are: which ones
  // the board has is board settings, and the same list drives both passes, so
  // adding a column mints its panel and removing one takes its panel away.
  it("never reaps a kind it unconditionally wants back", () => {
    const always = new Set(desiredStations([], [], []).map((ref) => ref.kind));
    for (const kind of PANEL_KINDS) {
      const manifest = panelManifest(kind);
      if (!manifest.reapable) continue;
      expect(always.has(kind)).toBe(false);
    }
    expect(always.has("composer")).toBe(true);
    expect(always.has("column")).toBe(false);
  });

  // Capture is home and never goes away. A column is a component you add and
  // remove, so it closes like every other page.
  it("keeps the capture composer force-present and everything else closable", () => {
    expect(isPanelClosable("composer")).toBe(false);
    expect(isPanelClosable("column")).toBe(true);
    expect(isPanelClosable("hermes")).toBe(true);
    expect(isPanelClosable("terminal")).toBe(true);
  });

  // A kind that cannot be closed has nothing to put back, and offering it in
  // the palette is offering a no-op.
  it("only offers closable kinds for adding", () => {
    for (const kind of ADDABLE_PANEL_KINDS) {
      expect(isPanelClosable(kind)).toBe(true);
    }
    expect(ADDABLE_PANEL_KINDS).toContain("terminal");
    expect(ADDABLE_PANEL_KINDS).toContain("explorer");
    expect(ADDABLE_PANEL_KINDS).toContain("prs");
    expect(ADDABLE_PANEL_KINDS).toContain("threads");
    expect(ADDABLE_PANEL_KINDS).toContain("column");
    expect(ADDABLE_PANEL_KINDS).not.toContain("composer");
  });
});

describe("the summary ladder", () => {
  // The point of holding it here: a kind cannot be added without an answer, and
  // "no answer" is spelled out rather than left to fall through to the live page.
  it("declares a rung for every kind", () => {
    for (const kind of PANEL_KINDS) {
      const summary = panelManifest(kind).summary;
      expect(summary.view).toBeTruthy();
      if (summary.view === "none") expect(summary.reason.length).toBeGreaterThan(0);
      if (summary.view === "static") expect(summary.line.length).toBeGreaterThan(0);
    }
  });

  it("gives the two kinds a zoomed-out canvas is a dashboard of a real view", () => {
    expect(panelManifest("column").summary.view).toBe("column");
    expect(panelManifest("thread").summary.view).toBe("thread");
  });

  // The review list is worth reading zoomed out — a count and a dot per pull
  // request is the whole panel, minus the rows you would drag.
  it("gives the review list a real rung rather than a placeholder", () => {
    expect(panelManifest("prs").summary.view).toBe("prs");
  });

  it("says why the kinds with nothing smaller to show have nothing", () => {
    expect(panelManifest("composer").summary.view).toBe("none");
    expect(panelManifest("board").summary.view).toBe("none");
  });
});

describe("panelCloseAction", () => {
  // Closing a window is never how a human kills a shell or a running turn.
  it("detaches from the kinds that front a live session", () => {
    expect(panelCloseAction("terminal")).toBe("detach");
    expect(panelCloseAction("thread")).toBe("detach");
  });

  it("just drops the kinds that front nothing", () => {
    expect(panelCloseAction("settings")).toBe("discard");
    expect(panelCloseAction("explorer")).toBe("discard");
  });
});

describe("a kind this build does not have", () => {
  // The union used to be closed and baked into the tldraw shape schema, so a
  // snapshot naming a kind this build lacks failed validation and took the
  // canvas with it. It is a plain box now — visible, movable, closable.
  it("gets a manifest instead of undefined", () => {
    const unknown = panelManifest("hologram");
    expect(unknown.label).toBe("Unknown panel");
    expect(unknown.size.w).toBeGreaterThan(0);
    expect(unknown.summary.view).toBe("none");
  });

  it("gets a size, so the canvas can place it", () => {
    expect(panelSize("hologram")).toEqual(panelManifest("hologram").size);
  });

  it("is closable and not offered in the add menu", () => {
    expect(isPanelClosable("hologram")).toBe(true);
    expect(ADDABLE_PANEL_KINDS).not.toContain("hologram");
  });
});
