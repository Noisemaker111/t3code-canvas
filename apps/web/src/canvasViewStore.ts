/**
 * canvasViewStore — how much of the canvas's own furniture is on screen.
 *
 * Browser-local rather than a board setting: this is "what do I want in front
 * of me on this machine right now", not something the server or another device
 * should inherit.
 */
import { create } from "zustand";

const STORAGE_KEY = "t3.canvas.view.v1";

interface CanvasViewState {
  /** Whether tldraw's toolbar, style panel and menus are put away. */
  toolsHidden: boolean;
  setToolsHidden: (hidden: boolean) => void;
  toggleTools: () => void;
}

function readStored(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(STORAGE_KEY) === "hidden";
}

export const useCanvasViewStore = create<CanvasViewState>()((set, get) => ({
  toolsHidden: readStored(),
  setToolsHidden: (hidden) => {
    if (hidden === get().toolsHidden) return;
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, hidden ? "hidden" : "shown");
    }
    set({ toolsHidden: hidden });
  },
  toggleTools: () => get().setToolsHidden(!get().toolsHidden),
}));
