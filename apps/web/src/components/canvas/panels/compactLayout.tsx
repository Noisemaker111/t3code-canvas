import { createContext, useContext, type ReactNode } from "react";

import { useIsMobile, useMediaQuery } from "../../../hooks/useMediaQuery";

/**
 * Whether the window has room for the app's own furniture.
 *
 * Height as well as width: a phone on its side is 844×390, wide enough for the
 * desktop header and short enough that two rows of it plus a panel title bar
 * were a quarter of the screen before the page started.
 */
export function useCompactShell(): boolean {
  return useMediaQuery("(max-width: 767px), (max-height: 559px)");
}

/**
 * Whether the surface a page is drawn on is phone-sized.
 *
 * A media query alone gets this wrong on the canvas: a panel's DOM is its
 * authored width — 1480px for the board — whatever device it is scaled onto, so
 * on a phone every `max-sm` in it fires while the box it lays out in is four
 * times the screen. The layer that knows both the device and whether this panel
 * is the one filling the window says so here instead.
 *
 * Outside a panel — `/settings`, a chat route — there is no provider and the
 * window is the surface, so the plain media query is the answer.
 */
const CompactLayoutContext = createContext<boolean | null>(null);

export function CompactLayoutProvider({
  compact,
  children,
}: {
  readonly compact: boolean;
  readonly children: ReactNode;
}) {
  return <CompactLayoutContext value={compact}>{children}</CompactLayoutContext>;
}

export function useCompactLayout(): boolean {
  const provided = useContext(CompactLayoutContext);
  const windowIsMobile = useIsMobile();
  return provided ?? windowIsMobile;
}
