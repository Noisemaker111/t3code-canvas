import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { nextTerminalId, resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  HOST_CONSOLE_THREAD_ID,
  resolveHostConsoleCwd,
  subscribeHostConsoleCommands,
  takeHostConsoleCommand,
} from "~/lib/hostConsole";
import { usePrimaryEnvironment } from "~/state/environments";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { terminalEnvironment } from "~/state/terminal";
import { useKnownTerminalSessions } from "~/state/terminalSessions";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  selectThreadTerminalUiState,
  useTerminalUiStateStore,
  type ThreadTerminalUiState,
} from "~/terminalUiStateStore";
import { DEFAULT_THREAD_TERMINAL_ID } from "~/types";

/**
 * The board's host console (HOME / root shell), as one hook.
 *
 * There is exactly one pty behind this: sessions are keyed by
 * {@link HOST_CONSOLE_THREAD_ID}, and both surfaces that show it — the drawer
 * pinned to the bottom of the board and the terminal panel on the canvas — go
 * through here. Two copies of this wiring would be two ways to open, split and
 * close the same shell, and they would disagree about which one is live.
 *
 * `showing` is whether the caller has the console on screen regardless of the
 * drawer's own open flag. It only decides whether the first shell gets booted;
 * nothing here ever ends a session, so a surface that goes away detaches from a
 * shell that keeps running.
 */
export function useHostConsole({ showing }: { readonly showing: boolean }) {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const cwd = resolveHostConsoleCwd(primaryEnvironment?.serverConfig ?? null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const threadId = HOST_CONSOLE_THREAD_ID;
  const threadRef = useMemo(
    () => (environmentId ? scopeThreadRef(environmentId, threadId) : null),
    [environmentId, threadId],
  );

  const terminalUiState: ThreadTerminalUiState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef),
  );
  const storeSetTerminalHeight = useTerminalUiStateStore((state) => state.setTerminalHeight);
  const storeSplitTerminal = useTerminalUiStateStore((state) => state.splitTerminal);
  const storeSplitTerminalVertical = useTerminalUiStateStore(
    (state) => state.splitTerminalVertical,
  );
  const storeNewTerminal = useTerminalUiStateStore((state) => state.newTerminal);
  const storeSetActiveTerminal = useTerminalUiStateStore((state) => state.setActiveTerminal);
  const storeCloseTerminal = useTerminalUiStateStore((state) => state.closeTerminal);
  const storeEnsureTerminal = useTerminalUiStateStore((state) => state.ensureTerminal);
  const storeSetTerminalOpen = useTerminalUiStateStore((state) => state.setTerminalOpen);
  const reconcileTerminalIds = useTerminalUiStateStore((state) => state.reconcileTerminalIds);

  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const closeTerminalMutation = useAtomCommand(terminalEnvironment.close, "terminal close");

  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId,
    threadId: environmentId ? threadId : null,
  });
  const serverOrderedTerminalIds = useMemo(
    () => knownTerminalSessions.map((session) => session.target.terminalId),
    [knownTerminalSessions],
  );
  const [focusRequestId, setFocusRequestId] = useState(0);
  const [pendingCommand, setPendingCommand] = useState<string | null>(null);

  // Drain on mount as well as on the ping: the click that parks a command is
  // what navigates here, so this console did not exist when it was sent.
  useEffect(() => {
    const drain = () => {
      const command = takeHostConsoleCommand();
      if (command === null) return;
      setPendingCommand(command);
      if (threadRef) {
        storeSetTerminalOpen(threadRef, true);
      }
    };
    drain();
    return subscribeHostConsoleCommands(drain);
  }, [storeSetTerminalOpen, threadRef]);

  useEffect(() => {
    if (!threadRef) return;
    if (
      serverOrderedTerminalIds.length === 0 ||
      serverOrderedTerminalIds.join("\0") === terminalUiState.terminalIds.join("\0")
    ) {
      return;
    }
    reconcileTerminalIds(threadRef, serverOrderedTerminalIds);
  }, [reconcileTerminalIds, serverOrderedTerminalIds, terminalUiState.terminalIds, threadRef]);

  const wanted = showing || terminalUiState.terminalOpen;
  useEffect(() => {
    if (!threadRef || !cwd || !environmentId || !wanted) {
      return;
    }
    if (terminalUiState.terminalIds.length > 0) {
      return;
    }
    const terminalId = DEFAULT_THREAD_TERMINAL_ID;
    storeEnsureTerminal(threadRef, terminalId, { open: true });
    void openTerminal({
      environmentId,
      input: {
        threadId,
        terminalId,
        cwd,
      },
    });
  }, [
    cwd,
    environmentId,
    openTerminal,
    wanted,
    storeEnsureTerminal,
    terminalUiState.terminalIds.length,
    threadId,
    threadRef,
  ]);

  useEffect(() => {
    if (!pendingCommand || !environmentId || terminalUiState.terminalIds.length === 0) return;
    const terminalId = terminalUiState.activeTerminalId ?? terminalUiState.terminalIds[0];
    if (!terminalId) return;
    // Wait for the server to own the pty. A command sent from settings arrives
    // before the shell it navigated to has booted, and a write to a session that
    // does not exist yet is typed into nothing.
    if (!serverOrderedTerminalIds.includes(terminalId)) return;
    setPendingCommand(null);
    void writeTerminal({
      environmentId,
      input: { threadId, terminalId, data: pendingCommand },
    });
  }, [
    environmentId,
    pendingCommand,
    serverOrderedTerminalIds,
    terminalUiState.activeTerminalId,
    terminalUiState.terminalIds,
    threadId,
    writeTerminal,
  ]);

  const bumpFocus = useCallback(() => {
    setFocusRequestId((value) => value + 1);
  }, []);

  const setTerminalHeight = useCallback(
    (height: number) => {
      if (!threadRef) return;
      storeSetTerminalHeight(threadRef, height);
    },
    [storeSetTerminalHeight, threadRef],
  );

  const openShell = useCallback(
    (terminalId: string) => {
      if (!threadRef || !cwd || !environmentId) return;
      void openTerminal({
        environmentId,
        input: {
          threadId,
          terminalId,
          cwd,
        },
      });
    },
    [cwd, environmentId, openTerminal, threadId, threadRef],
  );

  const splitTerminal = useCallback(() => {
    if (!threadRef || !cwd) return;
    const terminalId = nextTerminalId(serverOrderedTerminalIds);
    storeSplitTerminal(threadRef, terminalId);
    bumpFocus();
    openShell(terminalId);
  }, [bumpFocus, cwd, openShell, serverOrderedTerminalIds, storeSplitTerminal, threadRef]);

  const splitTerminalVertical = useCallback(() => {
    if (!threadRef || !cwd) return;
    const terminalId = nextTerminalId(serverOrderedTerminalIds);
    storeSplitTerminalVertical(threadRef, terminalId);
    bumpFocus();
    openShell(terminalId);
  }, [bumpFocus, cwd, openShell, serverOrderedTerminalIds, storeSplitTerminalVertical, threadRef]);

  const createNewTerminal = useCallback(() => {
    if (!threadRef || !cwd) return;
    const terminalId = nextTerminalId(serverOrderedTerminalIds);
    storeNewTerminal(threadRef, terminalId);
    bumpFocus();
    openShell(terminalId);
  }, [bumpFocus, cwd, openShell, serverOrderedTerminalIds, storeNewTerminal, threadRef]);

  const activateTerminal = useCallback(
    (terminalId: string) => {
      if (!threadRef) return;
      storeSetActiveTerminal(threadRef, terminalId);
      bumpFocus();
    },
    [bumpFocus, storeSetActiveTerminal, threadRef],
  );

  const closeTerminal = useCallback(
    (terminalId: string) => {
      if (!threadRef || !environmentId) return;
      const fallbackExitWrite = () =>
        writeTerminal({
          environmentId,
          input: { threadId, terminalId, data: "exit\n" },
        });

      void (async () => {
        const closeResult = await closeTerminalMutation({
          environmentId,
          input: {
            threadId,
            terminalId,
            deleteHistory: true,
          },
        });
        if (closeResult._tag === "Failure" && !isAtomCommandInterrupted(closeResult)) {
          await fallbackExitWrite();
        }
      })();

      storeCloseTerminal(threadRef, terminalId);
      bumpFocus();
    },
    [
      bumpFocus,
      closeTerminalMutation,
      environmentId,
      storeCloseTerminal,
      threadId,
      threadRef,
      writeTerminal,
    ],
  );

  const terminalLabelsById = useMemo(() => {
    const next = new Map<string, string>();
    for (const session of knownTerminalSessions) {
      next.set(
        session.target.terminalId,
        resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
      );
    }
    return next;
  }, [knownTerminalSessions]);

  return {
    threadRef,
    threadId,
    cwd,
    keybindings,
    terminalUiState,
    focusRequestId,
    setTerminalHeight,
    setTerminalOpen: storeSetTerminalOpen,
    splitTerminal,
    splitTerminalVertical,
    createNewTerminal,
    activateTerminal,
    closeTerminal,
    terminalLabelsById,
  };
}
