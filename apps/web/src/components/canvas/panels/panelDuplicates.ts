import { nextTerminalId } from "@t3tools/shared/terminalLabels";

import { parseThreadTerminalRef } from "./panelTerminal";
import { panelIdentity, type PanelRef } from "./panelStations";

/**
 * What creating a panel whose station already exists on the page should do.
 *
 * tldraw's copy/paste, Ctrl+D and alt-drag all clone the shape verbatim, and a
 * second shape with the same identity is a ghost: `panelShapes` keys panels by
 * station, so the layer never paints the clone. Two answers, by kind:
 *
 * - A terminal clone becomes a *new shell* — a fresh `term-N` entity id at the
 *   host console's cwd, so duplicating a terminal pane means "another shell
 *   where that one is", not a second window on the same pty.
 * - Any other duplicate is dropped. One station, one panel.
 *
 * @module components/canvas/panels/panelDuplicates
 */

export type DuplicatePanelResolution =
  | { readonly action: "keep" }
  | { readonly action: "drop" }
  | { readonly action: "retarget"; readonly entityId: string };

export function resolveDuplicatePanel(
  created: PanelRef,
  existingIdentities: ReadonlySet<string>,
  knownTerminalIds: ReadonlyArray<string>,
): DuplicatePanelResolution {
  if (!existingIdentities.has(panelIdentity(created))) return { action: "keep" };
  if (created.kind === "terminal") {
    return { action: "retarget", entityId: nextTerminalId(knownTerminalIds) };
  }
  return { action: "drop" };
}

/** The terminal ids a fresh shell's id must not collide with. */
export function knownTerminalIdsForMint(
  panelRefs: ReadonlyArray<PanelRef>,
  storeTerminalIds: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return [
    ...storeTerminalIds,
    // A thread's shells are addressed under that thread, so they are not names
    // a host-console shell can collide with.
    ...panelRefs
      .filter(
        (ref) =>
          ref.kind === "terminal" &&
          ref.entityId.length > 0 &&
          parseThreadTerminalRef(ref.entityId) === null,
      )
      .map((ref) => ref.entityId),
  ];
}
