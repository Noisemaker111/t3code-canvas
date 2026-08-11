/**
 * installLogStore — in-memory buffer for the host install log.
 *
 * The host's update hook appends a JSONL run log the server tails and streams over
 * the WebSocket. The catch is that installing restarts the server, so the
 * stream dies partway through every successful install. `lastLine` is the
 * recovery mechanism: the subscriber reconnects and asks for everything after
 * the last line it saw, so the pane picks up where it left off instead of going
 * blank or replaying from the top.
 *
 * Not persisted, and it does not need to be: the log lives in a file on the
 * server, so a page reload re-subscribes from line 0 and gets the whole run
 * replayed back. The pane is driven by the server's run pointer rather than by
 * the tab that happened to trigger the install.
 */
import type { ServerInstallLogEvent } from "@t3tools/contracts";
import { create } from "zustand";

/** Keep the pane bounded; a dependency install alone is thousands of lines. */
export const INSTALL_LOG_MAX_LINES = 4000;

interface InstallLogStoreState {
  readonly runId: string | null;
  readonly events: ReadonlyArray<ServerInstallLogEvent>;
  /** Highest line number received, i.e. the resume offset. */
  readonly lastLine: number;
  readonly streaming: boolean;
  readonly error: string | null;
  append: (events: ReadonlyArray<ServerInstallLogEvent>) => void;
  setStreaming: (streaming: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useInstallLogStore = create<InstallLogStoreState>((set) => ({
  runId: null,
  events: [],
  lastLine: 0,
  streaming: false,
  error: null,
  append: (incoming) =>
    set((state) => {
      if (incoming.length === 0) return state;
      const runId = incoming[incoming.length - 1]?.runId ?? state.runId;
      // A different run id means the host started a new install; drop the old
      // buffer rather than interleaving two runs in one pane.
      const isNewRun = state.runId !== null && runId !== state.runId;
      const base = isNewRun ? [] : state.events;
      const lastLine = isNewRun ? 0 : state.lastLine;
      const fresh = incoming.filter((event) => event.line > lastLine);
      if (fresh.length === 0 && !isNewRun) return state;
      const merged = [...base, ...fresh];
      return {
        ...state,
        runId,
        events:
          merged.length > INSTALL_LOG_MAX_LINES
            ? merged.slice(merged.length - INSTALL_LOG_MAX_LINES)
            : merged,
        lastLine: fresh.length > 0 ? fresh[fresh.length - 1]!.line : lastLine,
        error: null,
      };
    }),
  setStreaming: (streaming) => set((state) => ({ ...state, streaming })),
  setError: (error) => set((state) => ({ ...state, error })),
  reset: () => set({ runId: null, events: [], lastLine: 0, streaming: false, error: null }),
}));
