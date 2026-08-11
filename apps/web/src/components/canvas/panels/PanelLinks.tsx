import { useEditor, useValue } from "tldraw";

import {
  decodeLinks,
  encodeLinks,
  linkPath,
  panelLinks,
  type LinkablePanel,
} from "./panelLinksLogic";
import { panelShapes } from "./PanelShapeUtil";

/**
 * The arrows from a thread panel to the terminals and browser tabs that thread
 * opened, drawn over the canvas in one SVG.
 *
 * Geometry only — {@link panelLinks} decides which panels are linked, and the
 * boxes are read back every camera frame, so nothing here is stored, saved or
 * cleaned up. The layer never takes the pointer: a link is something to read,
 * not something to grab.
 */
export function PanelLinks({ hidden }: { readonly hidden: boolean }) {
  const editor = useEditor();
  // Serialized for the same reason `PanelLayer` serializes its entries: this
  // read touches every panel on the page, and a drawing stroke must not rebuild
  // the link set sixty times a second.
  const serialized = useValue(
    "panel links",
    () => {
      const camera = editor.getCamera();
      const panels: Array<LinkablePanel> = [];
      for (const entry of panelShapes(editor).values()) {
        const bounds = editor.getShapePageBounds(entry.id);
        if (bounds === undefined) continue;
        panels.push({
          key: entry.id,
          kind: entry.ref.kind,
          entityId: entry.ref.entityId,
          box: {
            x: (bounds.x + camera.x) * camera.z,
            y: (bounds.y + camera.y) * camera.z,
            w: bounds.w * camera.z,
            h: bounds.h * camera.z,
          },
        });
      }
      return encodeLinks(panelLinks(panels));
    },
    [editor],
  );

  if (hidden) return null;
  const links = decodeLinks(serialized);
  if (links.length === 0) return null;

  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full text-muted-foreground/70"
      style={{ zIndex: PANEL_LINK_Z }}
      data-testid="canvas-panel-links"
      aria-hidden
    >
      <defs>
        <marker
          id="t3-panel-link-head"
          markerWidth="8"
          markerHeight="8"
          refX="6"
          refY="4"
          orient="auto"
        >
          <path d="M 0 0 L 7 4 L 0 8 z" fill="currentColor" />
        </marker>
      </defs>
      {links.map((link) => (
        <path
          key={link.key}
          d={linkPath(link)}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          markerEnd="url(#t3-panel-link-head)"
        />
      ))}
    </svg>
  );
}

/** Under the panels, over tldraw's shapes: a link runs behind what it joins. */
const PANEL_LINK_Z = 150;
