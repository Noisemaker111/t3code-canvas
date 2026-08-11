/**
 * Level of detail — which of its three renders a panel gets at this zoom.
 *
 * A canvas holds more pages than a screen does. Rendering every one of them for
 * real is the difference between a board that pans at sixty frames and one that
 * boots a transcript, a terminal and a diff worker per panel you pass. So a
 * panel renders at one of three tiers:
 *
 * - `placeholder` — the box the shape already draws (`PanelShapeUtil`). Nothing
 *   mounted, nothing subscribed.
 * - `summary` — the per-kind degrade ladder each manifest declares: a title, a
 *   count, a status. Cheap by construction — no transcripts, no workers.
 * - `live` — the page itself.
 *
 * The tier comes from a panel's size *on screen*, not from the camera's zoom: a
 * thread panel at 1:1 and the same thread tiled six-up inside a frame are the
 * same zoom and very different amounts of pixel. {@link panelFit} states that as
 * a ratio against the kind's own `minSize` — the size the registry already calls
 * "the smallest this body is still readable at" — so one pair of thresholds
 * covers a 190px composer and a 920px settings page.
 *
 * No React and no tldraw in here. `PanelSummary` turns these into pixels.
 *
 * @module components/canvas/panels/panelTiers
 */

import { panelManifest, type PanelKind, type PanelSize } from "./panelRegistry";

export const PANEL_TIERS = ["placeholder", "summary", "live"] as const;
export type PanelTier = (typeof PANEL_TIERS)[number];

export interface ScreenSize {
  readonly w: number;
  readonly h: number;
}

/**
 * How many of the kind's readable minimums fit in the box it is drawn at. 1 is
 * exactly readable; 0.5 is half the size the body needs.
 *
 * The *smaller* of the two axes wins: a column squashed to 90px wide is
 * unreadable however tall it still is.
 */
export function panelFit(screen: ScreenSize, minSize: PanelSize): number {
  const fit = Math.min(screen.w / minSize.w, screen.h / minSize.h);
  return Number.isFinite(fit) && fit > 0 ? fit : 0;
}

/** Fit at or above which a panel renders for real, and stays a box below. */
export const PANEL_TIER_FIT = {
  live: 1,
  summary: 0.35,
} as const;

/**
 * How far below its entry threshold a tier holds on once it has it.
 *
 * Pinching sits on a threshold and jitters across it, and a panel that swapped
 * render on every frame of that gesture would strobe — and, at the live edge,
 * rebuild a transcript each time it crossed back. 15% is wider than the wobble
 * of a two-finger pinch and narrower than a deliberate zoom step.
 */
export const PANEL_TIER_HYSTERESIS = 0.15;

function threshold(entry: number, holding: boolean): number {
  return holding ? entry * (1 - PANEL_TIER_HYSTERESIS) : entry;
}

/**
 * The tier a box this size is in, before the kind's ladder has a say.
 *
 * `previous` is the tier this same panel was at on the last frame — pass null
 * for a panel that has not been drawn yet, which enters at the plain thresholds.
 */
export function panelSizeTier(fit: number, previous: PanelTier | null): PanelTier {
  if (fit >= threshold(PANEL_TIER_FIT.live, previous === "live")) return "live";
  if (fit >= threshold(PANEL_TIER_FIT.summary, previous === "summary")) return "summary";
  return "placeholder";
}

/**
 * What the kind actually renders at that tier: a kind whose manifest declares
 * no summary draws the placeholder instead of the summary.
 *
 * That is the declared answer, not a fallthrough — falling through to `live`
 * would put a full page behind every zoomed-out box, and a kind with no entry
 * at all is what this replaces.
 */
export function panelRenderTier(kind: PanelKind, sizeTier: PanelTier): PanelTier {
  if (sizeTier !== "summary") return sizeTier;
  return panelManifest(kind).summary.view === "none" ? "placeholder" : "summary";
}

/**
 * Whether the layer draws this panel's chrome, or leaves the box the shape
 * already paints to stand for it.
 */
export function panelChromeDrawn(renderTier: PanelTier): boolean {
  return renderTier !== "placeholder";
}

/**
 * Which tier a free panel draws at once the pointer and station state are known.
 *
 * `live` (pointer) wins: a panel under the cursor or focused is the page. A
 * station over the canvas is the other half — that one panel is the window, so
 * every other free panel is at most a summary even when its on-screen box is
 * still large enough to be live. Leaving those at live would keep a second
 * xterm / transcript / browser session mounted behind the focused page.
 */
export function panelLayerTier(input: {
  readonly live: boolean;
  readonly stationed: boolean;
  readonly sizeTier: PanelTier;
}): PanelTier {
  if (input.live) return "live";
  if (input.stationed && input.sizeTier === "live") return "summary";
  return input.sizeTier;
}

/**
 * Whether a kind's heavy body (pty, browser guest, …) should be open at this
 * tier. Transcripts stay latched so zoom does not drop a draft; a terminal or
 * browser remounts from the session, so only the live tier pays for an xterm.
 */
export function panelHeavyBodyOpen(kind: PanelKind, renderTier: PanelTier): boolean {
  if (kind === "terminal" || kind === "browser") return renderTier === "live";
  return true;
}

/** Both halves at once, for a panel drawn at `screen` with a remembered tier. */
export function panelTier(input: {
  readonly kind: PanelKind;
  readonly screen: ScreenSize;
  readonly previous: PanelTier | null;
}): { readonly size: PanelTier; readonly render: PanelTier } {
  const size = panelSizeTier(
    panelFit(input.screen, panelManifest(input.kind).minSize),
    input.previous,
  );
  return { size, render: panelRenderTier(input.kind, size) };
}
