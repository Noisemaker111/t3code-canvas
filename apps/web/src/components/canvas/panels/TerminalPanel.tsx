import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import { useCallback, useMemo } from "react";
import { createShapeId, useEditor } from "tldraw";

import { HOST_CONSOLE_THREAD_ID, resolveHostConsoleCwd } from "~/lib/hostConsole";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { usePrimaryEnvironment } from "~/state/environments";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useKnownTerminalSessions } from "~/state/terminalSessions";
import ThreadTerminalDrawer, { TerminalViewport } from "../../ThreadTerminalDrawer";
import { useHostConsole } from "../../kanban/useHostConsole";
import { panelSize } from "./panelRegistry";
import { parseThreadTerminalRef } from "./panelTerminal";
import { panelIdentity } from "./panelStations";
import { closePanel, PANEL_SHAPE_TYPE, panelShapes } from "./PanelShapeUtil";

/**
 * A shell as a place on the canvas. A panel is a window onto one pty, never a
 * second shell, so closing it does nothing to the session: reopening the panel
 * finds the scrollback it had.
 *
 * Three shapes of it: the empty entity id is the host console itself, tabs and
 * all; `terminal:<terminalId>` is one shell of that console as its own pane —
 * what duplicating a terminal pane or dragging a tab onto the canvas produces;
 * and `terminal:<threadId>/<terminalId>` is a shell a thread is running, which
 * the canvas mints itself so the commands an agent runs are watched from
 * outside the thread.
 */
export function TerminalPanel({
  entityId,
  opened,
}: {
  readonly entityId: string;
  readonly opened: boolean;
}) {
  const threadTerminal = parseThreadTerminalRef(entityId);
  if (threadTerminal !== null) {
    return (
      <ThreadTerminalPanel
        threadId={threadTerminal.threadId}
        terminalId={threadTerminal.terminalId}
        opened={opened}
      />
    );
  }
  if (entityId.length > 0) {
    return <SingleTerminalPanel terminalId={entityId} opened={opened} />;
  }
  return <HostConsolePanel opened={opened} />;
}

function noop() {}

/**
 * One shell of one thread. The cwd is the pty's own — read off the session
 * roster rather than guessed from the project, because a thread's shells run in
 * its worktree and a panel that opened them somewhere else would be a second,
 * different shell wearing the same name.
 */
function ThreadTerminalPanel({
  threadId,
  terminalId,
  opened,
}: {
  readonly threadId: string;
  readonly terminalId: string;
  readonly opened: boolean;
}) {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const sessions = useKnownTerminalSessions({
    environmentId,
    threadId: environmentId === null ? null : ThreadId.make(threadId),
  });
  const summary =
    sessions.find((session) => session.target.terminalId === terminalId)?.state.summary ?? null;
  const threadRef = useMemo(
    () => (environmentId === null ? null : scopeThreadRef(environmentId, ThreadId.make(threadId))),
    [environmentId, threadId],
  );
  const ignoreTerminalContext = useCallback((_selection: TerminalContextSelection) => {
    // A canvas pane is not attached to a composer draft.
  }, []);

  if (threadRef === null || summary === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {threadRef === null ? "Connect an environment to open the shell." : "This shell was closed"}
      </div>
    );
  }

  if (!opened) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-1 p-5">
        <p className="truncate font-mono text-[11px] text-muted-foreground/80">{summary.cwd}</p>
        <p className="mt-auto text-[11px] text-muted-foreground/70">Zoom in to open the shell.</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TerminalViewport
        threadRef={threadRef}
        threadId={ThreadId.make(threadId)}
        terminalId={terminalId}
        terminalLabel={getTerminalLabel(terminalId)}
        cwd={summary.cwd}
        worktreePath={summary.worktreePath}
        // The pty exiting takes the session off the roster, and the roster is
        // what the canvas mints these from — so the panel goes on the next
        // reconcile pass rather than closing itself twice.
        onSessionExited={noop}
        onAddTerminalContext={ignoreTerminalContext}
        focusRequestId={0}
        // A panel nobody opened must not take the keyboard off whatever the
        // human is typing in.
        autoFocus={false}
        resizeEpoch={0}
        drawerHeight={0}
        keybindings={keybindings}
      />
    </div>
  );
}

function HostConsolePanel({ opened }: { readonly opened: boolean }) {
  const host = useHostConsole({ showing: opened });
  const tearOffTerminal = useTearOffTerminal();
  const ignoreTerminalContext = useCallback((_selection: TerminalContextSelection) => {
    // The host console is not attached to a composer draft.
  }, []);

  if (host.threadRef === null || host.cwd === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Connect an environment to open the host console.
      </div>
    );
  }

  if (!opened) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-1 p-5">
        <p className="truncate font-mono text-[11px] text-muted-foreground/80">{host.cwd}</p>
        <p className="mt-auto text-[11px] text-muted-foreground/70">Zoom in to open the shell.</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ThreadTerminalDrawer
        mode="panel"
        threadRef={host.threadRef}
        threadId={host.threadId}
        cwd={host.cwd}
        worktreePath={null}
        runtimeEnv={{}}
        visible
        height={host.terminalUiState.terminalHeight}
        terminalIds={host.terminalUiState.terminalIds}
        activeTerminalId={host.terminalUiState.activeTerminalId}
        terminalGroups={host.terminalUiState.terminalGroups}
        activeTerminalGroupId={host.terminalUiState.activeTerminalGroupId}
        focusRequestId={host.focusRequestId}
        onSplitTerminal={host.splitTerminal}
        onSplitTerminalVertical={host.splitTerminalVertical}
        onNewTerminal={host.createNewTerminal}
        keybindings={host.keybindings}
        onActiveTerminalChange={host.activateTerminal}
        onCloseTerminal={host.closeTerminal}
        onHeightChange={host.setTerminalHeight}
        onAddTerminalContext={ignoreTerminalContext}
        terminalLabelsById={host.terminalLabelsById}
        onTearOffTerminal={tearOffTerminal}
      />
    </div>
  );
}

/**
 * One shell of the host console as its own pane. Attaching opens the pty if it
 * does not exist yet (`TerminalManager.attachStream` is open-or-attach), so a
 * freshly minted `term-N` boots a shell at the console's cwd on first render.
 */
function SingleTerminalPanel({
  terminalId,
  opened,
}: {
  readonly terminalId: string;
  readonly opened: boolean;
}) {
  const editor = useEditor();
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const cwd = resolveHostConsoleCwd(primaryEnvironment?.serverConfig ?? null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const threadRef = useMemo(
    () => (environmentId ? scopeThreadRef(environmentId, HOST_CONSOLE_THREAD_ID) : null),
    [environmentId],
  );
  const ignoreTerminalContext = useCallback((_selection: TerminalContextSelection) => {
    // Not attached to a composer draft.
  }, []);
  // The pty exited: the pane is a window onto nothing, so it closes itself.
  const onSessionExited = useCallback(() => {
    const shape = panelShapes(editor).get(
      panelIdentity({ kind: "terminal", entityId: terminalId }),
    );
    if (shape !== undefined) closePanel(editor, shape.id);
  }, [editor, terminalId]);

  if (threadRef === null || cwd === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Connect an environment to open the shell.
      </div>
    );
  }

  if (!opened) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-1 p-5">
        <p className="truncate font-mono text-[11px] text-muted-foreground/80">{cwd}</p>
        <p className="mt-auto text-[11px] text-muted-foreground/70">Zoom in to open the shell.</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TerminalViewport
        threadRef={threadRef}
        threadId={HOST_CONSOLE_THREAD_ID}
        terminalId={terminalId}
        terminalLabel={getTerminalLabel(terminalId)}
        cwd={cwd}
        onSessionExited={onSessionExited}
        onAddTerminalContext={ignoreTerminalContext}
        focusRequestId={0}
        autoFocus
        resizeEpoch={0}
        drawerHeight={0}
        keybindings={keybindings}
      />
    </div>
  );
}

/**
 * Land a shell dragged out of the console's sidebar on the canvas: an existing
 * pane for it moves under the pointer, otherwise a `terminal:<id>` pane is
 * created there — a second window onto the same pty, not a new shell.
 */
function useTearOffTerminal() {
  const editor = useEditor();
  return useCallback(
    (terminalId: string, point: { readonly x: number; readonly y: number }) => {
      const page = editor.screenToPage({ x: point.x, y: point.y });
      const size = panelSize("terminal");
      const x = page.x - size.w / 2;
      const y = page.y - 16;
      const existing = panelShapes(editor).get(
        panelIdentity({ kind: "terminal", entityId: terminalId }),
      );
      editor.markHistoryStoppingPoint("tear off terminal");
      if (existing !== undefined) {
        editor.updateShape({ id: existing.id, type: PANEL_SHAPE_TYPE, x, y });
        editor.bringToFront([existing.id]);
        return;
      }
      editor.createShapes([
        {
          id: createShapeId(),
          type: PANEL_SHAPE_TYPE,
          x,
          y,
          props: { w: size.w, h: size.h, kind: "terminal", entityId: terminalId },
        },
      ]);
    },
    [editor],
  );
}
