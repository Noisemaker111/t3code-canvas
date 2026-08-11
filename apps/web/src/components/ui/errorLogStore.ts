import { create } from "zustand";

import { fixItPrompt } from "~/lib/fixIt";

export interface ErrorLogEntry {
  id: string;
  title: string;
  description: string;
  timestamp: number;
}

interface ErrorLogState {
  entries: ErrorLogEntry[];
  isModalOpen: boolean;
  addEntry: (entry: { id: string; title: string; description: string }) => void;
  dismissEntry: (id: string) => void;
  clear: () => void;
  setModalOpen: (open: boolean) => void;
}

const MAX_ERROR_LOG_ENTRIES = 50;

export const useErrorLogStore = create<ErrorLogState>()((set) => ({
  entries: [],
  isModalOpen: false,
  addEntry: (entry) =>
    set((state) => {
      if (state.entries.some((existing) => existing.id === entry.id)) return state;
      const next = [{ ...entry, timestamp: Date.now() }, ...state.entries];
      return { entries: next.slice(0, MAX_ERROR_LOG_ENTRIES) };
    }),
  dismissEntry: (id) =>
    set((state) => ({ entries: state.entries.filter((entry) => entry.id !== id) })),
  clear: () => set({ entries: [] }),
  setModalOpen: (open) => set({ isModalOpen: open }),
}));

/** Clipboard text and the Fix it prompt are the same prompt — see `lib/fixIt`. */
export function formatErrorLogForCopy(entries: readonly ErrorLogEntry[]): string {
  return fixItPrompt(entries);
}
