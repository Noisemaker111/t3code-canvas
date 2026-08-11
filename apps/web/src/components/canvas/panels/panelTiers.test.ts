import { describe, expect, it } from "@effect/vitest";

import { framePreset } from "./panelFrames";
import { PANEL_TITLE_BAR_HEIGHT, PANEL_KINDS, panelManifest } from "./panelRegistry";
import { isKanbanRegionKind, stationCamera } from "./panelStations";
import {
  PANEL_TIER_FIT,
  PANEL_TIER_HYSTERESIS,
  panelChromeDrawn,
  panelFit,
  panelHeavyBodyOpen,
  panelLayerTier,
  panelRenderTier,
  panelSizeTier,
  panelTier,
  type PanelTier,
} from "./panelTiers";

const COLUMN_MIN = panelManifest("column").minSize;

describe("panelFit", () => {
  it("is 1 when the box is exactly the kind's readable minimum", () => {
    expect(panelFit({ w: COLUMN_MIN.w, h: COLUMN_MIN.h }, COLUMN_MIN)).toBe(1);
  });

  // A column squashed to a strip is unreadable however tall it still is.
  it("takes the tighter axis", () => {
    expect(panelFit({ w: COLUMN_MIN.w / 4, h: COLUMN_MIN.h * 8 }, COLUMN_MIN)).toBeCloseTo(0.25);
  });

  it("reads a collapsed box as nothing rather than as infinity", () => {
    expect(panelFit({ w: 0, h: 0 }, COLUMN_MIN)).toBe(0);
    expect(panelFit({ w: -20, h: 400 }, COLUMN_MIN)).toBe(0);
  });
});

describe("panelSizeTier", () => {
  it("renders for real once the body has the room it asks for", () => {
    expect(panelSizeTier(PANEL_TIER_FIT.live, null)).toBe("live");
    expect(panelSizeTier(PANEL_TIER_FIT.live - 0.01, null)).toBe("summary");
  });

  it("summarizes down to the placeholder threshold, then stops drawing", () => {
    expect(panelSizeTier(PANEL_TIER_FIT.summary, null)).toBe("summary");
    expect(panelSizeTier(PANEL_TIER_FIT.summary - 0.01, null)).toBe("placeholder");
    expect(panelSizeTier(0, null)).toBe("placeholder");
  });

  // A pinch parked on a threshold must not swap the render every frame — at the
  // live edge that is a transcript rebuilt sixty times a second.
  it("holds the tier it has across the boundary it entered at", () => {
    const justBelowLive = PANEL_TIER_FIT.live * (1 - PANEL_TIER_HYSTERESIS / 2);
    expect(panelSizeTier(justBelowLive, "live")).toBe("live");
    expect(panelSizeTier(justBelowLive, "summary")).toBe("summary");

    const justBelowSummary = PANEL_TIER_FIT.summary * (1 - PANEL_TIER_HYSTERESIS / 2);
    expect(panelSizeTier(justBelowSummary, "summary")).toBe("summary");
    expect(panelSizeTier(justBelowSummary, "placeholder")).toBe("placeholder");
  });

  it("gives the tier up past the far side of the hysteresis band", () => {
    expect(panelSizeTier(PANEL_TIER_FIT.live * (1 - PANEL_TIER_HYSTERESIS) - 0.01, "live")).toBe(
      "summary",
    );
    expect(
      panelSizeTier(PANEL_TIER_FIT.summary * (1 - PANEL_TIER_HYSTERESIS) - 0.01, "summary"),
    ).toBe("placeholder");
  });

  // Falling from live must never skip the summary it is about to hold.
  it("keeps the ladder monotone on the way down from live", () => {
    const seen: Array<PanelTier> = [];
    let previous: PanelTier | null = "live";
    for (let fit = 1.2; fit >= 0; fit -= 0.02) {
      previous = panelSizeTier(fit, previous);
      if (seen[seen.length - 1] !== previous) seen.push(previous);
    }
    expect(seen).toEqual(["live", "summary", "placeholder"]);
  });

  it("does not strobe while a pinch wobbles across the live threshold", () => {
    const wobble = [1.02, 0.98, 1.01, 0.96, 1.03, 0.99];
    let previous: PanelTier | null = "live";
    for (const fit of wobble) {
      previous = panelSizeTier(fit, previous);
      expect(previous).toBe("live");
    }
  });
});

describe("panelRenderTier", () => {
  it("draws the placeholder for a kind that declares no summary", () => {
    expect(panelManifest("composer").summary.view).toBe("none");
    expect(panelRenderTier("composer", "summary")).toBe("placeholder");
  });

  it("leaves the other two tiers alone whatever the ladder says", () => {
    expect(panelRenderTier("composer", "live")).toBe("live");
    expect(panelRenderTier("composer", "placeholder")).toBe("placeholder");
    expect(panelRenderTier("column", "summary")).toBe("summary");
  });
});

describe("panelChromeDrawn", () => {
  it("leaves the shape's own box to stand for a panel too small to read", () => {
    expect(panelChromeDrawn("placeholder")).toBe(false);
  });

  it("draws the chrome at every tier that renders something", () => {
    for (const renderTier of ["summary", "live"] as const) {
      expect(panelChromeDrawn(renderTier)).toBe(true);
    }
  });

  it("puts a title bar's worth of height under the tier that hides it", () => {
    for (const kind of PANEL_KINDS) {
      const screen = { w: panelManifest(kind).size.w, h: PANEL_TITLE_BAR_HEIGHT };
      expect(panelTier({ kind, screen, previous: null }).render).toBe("placeholder");
    }
  });
});

describe("panelLayerTier", () => {
  it("keeps a live panel live whatever the station", () => {
    expect(panelLayerTier({ live: true, stationed: true, sizeTier: "summary" })).toBe("live");
    expect(panelLayerTier({ live: true, stationed: false, sizeTier: "placeholder" })).toBe("live");
  });

  // ?station=terminal focuses the host console; a tear-off shell still on the
  // page at 820px must not stay live-tier or two xterms attach to the same pty.
  it("demotes a free live-sized panel when another station is the window", () => {
    expect(panelLayerTier({ live: false, stationed: true, sizeTier: "live" })).toBe("summary");
  });

  it("leaves summary and placeholder alone under a station", () => {
    expect(panelLayerTier({ live: false, stationed: true, sizeTier: "summary" })).toBe("summary");
    expect(panelLayerTier({ live: false, stationed: true, sizeTier: "placeholder" })).toBe(
      "placeholder",
    );
  });

  it("keeps a large off-screen panel live when nothing is stationed", () => {
    expect(panelLayerTier({ live: false, stationed: false, sizeTier: "live" })).toBe("live");
  });
});

describe("panelHeavyBodyOpen", () => {
  it("opens a terminal or browser only at the live tier", () => {
    expect(panelHeavyBodyOpen("terminal", "live")).toBe(true);
    expect(panelHeavyBodyOpen("terminal", "summary")).toBe(false);
    expect(panelHeavyBodyOpen("browser", "placeholder")).toBe(false);
  });

  it("does not gate kinds that keep a transcript or draft latched", () => {
    expect(panelHeavyBodyOpen("thread", "summary")).toBe(true);
    expect(panelHeavyBodyOpen("settings", "placeholder")).toBe(true);
  });
});

describe("panelTier", () => {
  // Two thirds is a column you can still read the card titles on — the zoom
  // the board frame lives at. It takes a real zoom-out to reach the dots.
  it("keeps a column panel scaled to two thirds on the cards", () => {
    const size = panelManifest("column").size;
    expect(
      panelTier({
        kind: "column",
        screen: { w: size.w * 0.66, h: size.h * 0.66 },
        previous: null,
      }),
    ).toEqual({ size: "live", render: "live" });
  });

  it("summarizes a column panel scaled to a third", () => {
    const size = panelManifest("column").size;
    expect(
      panelTier({
        kind: "column",
        screen: { w: size.w * 0.33, h: size.h * 0.33 },
        previous: null,
      }),
    ).toEqual({ size: "summary", render: "summary" });
  });

  // Six threads tiled in a 1680x1020 frame, that frame scaled to fit a laptop
  // window: the case the summary tier exists for.
  it("summarizes the tiles of a six-up thread frame", () => {
    const zoom = 0.5;
    const cell = { w: (1680 / 3) * zoom, h: ((1020 - 32) / 2) * zoom };
    expect(panelTier({ kind: "thread", screen: cell, previous: null }).render).toBe("summary");
  });

  // The same frame filling the screen is six real threads, not six cards.
  it("renders those tiles for real once the frame is at 1:1", () => {
    const cell = { w: 1680 / 3, h: (1020 - 32) / 2 };
    expect(panelTier({ kind: "thread", screen: cell, previous: null }).render).toBe("live");
  });

  // The board frame parks its four columns at 361x796 css and the camera sits
  // around 0.65: what the home screen is actually drawn at. Cards, not dots.
  it("renders a board column for real at the zoom the board frame sits at", () => {
    expect(panelTier({ kind: "column", screen: { w: 236, h: 520 }, previous: null }).render).toBe(
      "live",
    );
  });

  it("reports the size tier a kind with no summary degraded away from", () => {
    const min = panelManifest("composer").minSize;
    expect(
      panelTier({ kind: "composer", screen: { w: min.w * 0.6, h: min.h * 0.6 }, previous: null }),
    ).toEqual({ size: "summary", render: "placeholder" });
  });

  it("renders any kind for real at its authored size", () => {
    for (const kind of PANEL_KINDS) {
      const size = panelManifest(kind).size;
      expect(panelTier({ kind, screen: size, previous: null }).render).toBe("live");
    }
  });
});

// The board station fits the whole kanban region to the window, so every panel
// in it is drawn at one zoom. A kind whose minimum is a larger fraction of its
// own size than the columns' goes blank at a zoom the columns survive — which
// is how the home screen lost its capture bar on every window under 2560x1440.
describe("the kanban region degrades as one", () => {
  const columnFraction = {
    w: panelManifest("column").minSize.w / panelManifest("column").size.w,
    h: panelManifest("column").minSize.h / panelManifest("column").size.h,
  };

  for (const kind of PANEL_KINDS.filter((entry) => isKanbanRegionKind(entry))) {
    it(`keeps ${kind} live wherever a column is`, () => {
      const manifest = panelManifest(kind);
      expect(manifest.minSize.w / manifest.size.w).toBeLessThanOrEqual(columnFraction.w);
      expect(manifest.minSize.h / manifest.size.h).toBeLessThanOrEqual(columnFraction.h);
    });
  }

  // The windows the board is actually opened on. The camera fits the Board
  // frame — the region plus its padding and title bar — and every panel in it
  // has to still be the page it is at that zoom, capture bar included.
  for (const screen of [
    { w: 1280, h: 800 },
    { w: 1440, h: 900 },
    { w: 1600, h: 1000 },
    { w: 1920, h: 1080 },
    { w: 2560, h: 1440 },
  ]) {
    it(`draws the whole region for real at ${screen.w}x${screen.h}`, () => {
      const frame = framePreset("board").size;
      const { z } = stationCamera({ x: 0, y: 0, ...frame }, screen);
      for (const kind of PANEL_KINDS.filter((entry) => isKanbanRegionKind(entry))) {
        const size = panelManifest(kind).size;
        expect(
          panelTier({ kind, screen: { w: size.w * z, h: size.h * z }, previous: null }).render,
        ).toBe("live");
      }
    });
  }
});
