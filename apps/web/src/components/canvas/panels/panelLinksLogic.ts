/**
 * The lines drawn from a thread panel to the panels that thread opened.
 *
 * A terminal or a browser tab appearing on the canvas is only legible if you
 * can see *whose* it is, so ownership is drawn rather than written: one curve
 * from the bottom of the thread to the top of each panel it opened. The link is
 * derived from the panels' addresses ({@link panelThreadScope}) every frame —
 * nothing is stored, so a panel dragged, closed or reaped needs no cleanup.
 *
 * @module components/canvas/panels/panelLinksLogic
 */

import { owningThreadId } from "./panelThreadScope";
import type { Box, PanelKind } from "./panelStations";

export interface LinkablePanel {
  readonly key: string;
  readonly kind: PanelKind;
  readonly entityId: string;
  readonly box: Box;
}

export interface PanelLink {
  readonly key: string;
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
}

/** The kinds a thread opens for itself. Everything else is a human's panel. */
const SATELLITE_KINDS: ReadonlySet<PanelKind> = new Set<PanelKind>(["terminal", "browser"]);

/**
 * Thread → satellite pairs, as the two points a curve runs between: the bottom
 * edge of the thread panel and the top edge of the panel it opened.
 *
 * A satellite whose thread has no panel on the canvas draws no link. The panel
 * still stands on its own — the thread being closed is not a reason to stop
 * showing the shell that is still running.
 */
export function panelLinks(panels: ReadonlyArray<LinkablePanel>): ReadonlyArray<PanelLink> {
  const threads = new Map<string, LinkablePanel>();
  for (const panel of panels) {
    if (panel.kind === "thread") threads.set(panel.entityId, panel);
  }
  const links: Array<PanelLink> = [];
  for (const panel of panels) {
    if (!SATELLITE_KINDS.has(panel.kind)) continue;
    const threadId = owningThreadId(panel.entityId);
    if (threadId === null) continue;
    const thread = threads.get(threadId);
    if (thread === undefined) continue;
    links.push({
      key: panel.key,
      from: { x: thread.box.x + thread.box.w / 2, y: thread.box.y + thread.box.h },
      to: { x: panel.box.x + panel.box.w / 2, y: panel.box.y },
    });
  }
  return links;
}

/**
 * A link set as one string, so the layer that draws it re-renders when the
 * links move and not when anything else on the page does — the same trick
 * `PanelLayer` plays with its entries. Hand-rolled rather than JSON so decoding
 * is a parse with rules rather than a cast.
 */
const FIELD = "\u001f";
const ROW = "\u001e";

export function encodeLinks(links: ReadonlyArray<PanelLink>): string {
  return links
    .map((link) => [link.key, link.from.x, link.from.y, link.to.x, link.to.y].join(FIELD))
    .join(ROW);
}

export function decodeLinks(encoded: string): ReadonlyArray<PanelLink> {
  if (encoded.length === 0) return [];
  const links: Array<PanelLink> = [];
  for (const row of encoded.split(ROW)) {
    const [key, ...rest] = row.split(FIELD);
    if (key === undefined || key.length === 0 || rest.length !== 4) continue;
    const [fromX, fromY, toX, toY] = rest.map(Number);
    if (![fromX, fromY, toX, toY].every((value) => value !== undefined && Number.isFinite(value)))
      continue;
    links.push({
      key,
      from: { x: fromX ?? 0, y: fromY ?? 0 },
      to: { x: toX ?? 0, y: toY ?? 0 },
    });
  }
  return links;
}

/**
 * The curve itself: down out of the thread, across, and down into the panel.
 *
 * Vertical tangents at both ends, so a link reads as "this came out of that"
 * however far the two have been dragged apart sideways.
 */
export function linkPath(link: PanelLink): string {
  const span = Math.abs(link.to.y - link.from.y);
  const lift = Math.max(24, Math.min(140, span / 2));
  return [
    `M ${round(link.from.x)} ${round(link.from.y)}`,
    `C ${round(link.from.x)} ${round(link.from.y + lift)},`,
    `${round(link.to.x)} ${round(link.to.y - lift)},`,
    `${round(link.to.x)} ${round(link.to.y)}`,
  ].join(" ");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
