import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ServerUpdateState } from "@t3tools/contracts";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  Loader2Icon,
  RefreshCwIcon,
  RotateCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection, settingsPageShell } from "./settingsLayout";
import { APP_VERSION, HOSTED_APP_CHANNEL } from "../../branding";
import { isElectron } from "../../env";
import { AboutVersionSection } from "./SettingsPanels";
import { useInstallLogStore } from "../../installLogStore";
import { subscribeInstallLog } from "../../state/installLog";
import {
  captureInstallTarget,
  deriveInstallLogTail,
  deriveInstallProgress,
  isServerUpdateRejection,
  resolveOwnRun,
  type InstallProgress,
  type InstallTarget,
} from "./updateInstallFlow.logic";

// How often to re-poll the server for install progress. Short enough that the
// user sees the flow advance promptly, long enough not to hammer the socket.
const INSTALL_POLL_INTERVAL_MS = 2_500;
// The install restarts the server, so the log stream dies partway through every
// successful run. Re-attach on this cadence, resuming from the last line seen.
const LOG_RESUBSCRIBE_INTERVAL_MS = 2_000;

function shortCommit(commit: string | null): string {
  if (!commit) return "unknown";
  return commit.slice(0, 12);
}

function statusLabel(state: ServerUpdateState): string {
  switch (state.status) {
    case "checking":
      return "Checking…";
    case "available":
      return "Update available";
    case "up-to-date":
      return "Up to date";
    case "installing":
      return "Installing…";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
}

function installPhaseLabel(progress: InstallProgress): string {
  switch (progress.phase) {
    case "installing":
      return "Installing…";
    case "restarting":
      return "Restarting…";
    case "completed":
      return "Update installed";
    case "deferred":
      return "Not installed";
    case "failed":
      return "Install failed";
    default:
      return "Installing…";
  }
}

export function UpdateSettingsPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const [installing, setInstalling] = useState(false);

  const { data, error, refresh } = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.updateState({ environmentId, input: {} }),
  );
  const installUpdate = useAtomCommand(serverEnvironment.installUpdate, { reportFailure: false });

  // Active install flow. `target` records the commit endpoints captured at
  // trigger time so completion can be detected purely by the deployed commit
  // advancing — the flow survives the server restart that resets its in-memory
  // status. `startedAt` measures elapsed time for the settle grace window.
  const [installFlow, setInstallFlow] = useState<{
    readonly target: InstallTarget;
    readonly startedAt: number;
  } | null>(null);
  const [installProgress, setInstallProgress] = useState<InstallProgress | null>(null);
  // Run the user hid. Kept so hiding a failed run's log doesn't fight the tail,
  // which would otherwise pull it straight back out of the file.
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(null);
  const notifiedTerminalRef = useRef(false);

  const handleUpdate = useCallback(() => {
    const previousResultIsTerminal = installProgress?.terminal ?? false;
    if (
      environmentId === null ||
      installing ||
      (installFlow !== null && !previousResultIsTerminal)
    ) {
      return;
    }

    // Enter the observable flow before sending the command. A successful update
    // restarts this server and intentionally drops the RPC socket; if that wins
    // the race with the response, polling the deployed commit is the truth.
    const target = captureInstallTarget(data ?? null);
    notifiedTerminalRef.current = false;
    useInstallLogStore.getState().reset();
    setDismissedRunId(null);
    setInstallFlow({ target, startedAt: Date.now() });
    setInstallProgress({
      phase: "installing",
      message: "Checking for a new version…",
      terminal: false,
    });
    setInstalling(true);

    void installUpdate({ environmentId, input: { force: true } })
      .then((result) => {
        if (result._tag === "Failure") {
          const failure = squashAtomCommandFailure(result);
          if (isServerUpdateRejection(failure)) {
            // A typed reply proves the server refused before a restart. A plain
            // transport failure proves nothing: it is the expected shape of a
            // restart, so keep polling instead of showing a false retry error.
            setInstallFlow(null);
            setInstallProgress(null);
            toastManager.add({
              type: "error",
              title: "Could not update T3J",
              description: failure instanceof Error ? failure.message : "Update failed.",
            });
            refresh();
          }
          return;
        }

        const next = result.value;
        if (next.status === "up-to-date") {
          setInstallFlow(null);
          setInstallProgress(null);
          toastManager.add({
            type: "success",
            title: "T3J is up to date",
            description: "You are already running the latest version.",
          });
          refresh();
          return;
        }

        // The atomic server command fetched the real target and opened the run
        // before triggering the deploy, so its answer names both endpoints of
        // this install exactly. Everything after this point is about that run.
        setInstallFlow((current) =>
          current === null
            ? null
            : { ...current, target: captureInstallTarget(next, current.target) },
        );
        refresh();
      })
      .finally(() => {
        setInstalling(false);
      });
  }, [
    data,
    environmentId,
    installFlow,
    installProgress?.terminal,
    installUpdate,
    installing,
    refresh,
  ]);

  // While an install is in flight, poll the server for progress. Each tick
  // refreshes the update-state query; the effect below folds the result into a
  // phase. Polling stops as soon as the flow reaches a terminal outcome.
  const terminalReached = installProgress?.terminal ?? false;
  useEffect(() => {
    if (installFlow === null || terminalReached) return;
    const interval = window.setInterval(() => refresh(), INSTALL_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [installFlow, terminalReached, refresh]);

  // Fold every state/connection change into the install phase. `reachable` is
  // derived from whether the last query errored (the socket is torn down while
  // the server restarts, which surfaces as a query failure).
  useEffect(() => {
    if (installFlow === null) return;
    const progress = deriveInstallProgress(installFlow.target, {
      state: data ?? null,
      reachable: error === null,
      elapsedMs: Date.now() - installFlow.startedAt,
    });
    setInstallProgress(progress);
    if (progress.terminal && !notifiedTerminalRef.current) {
      notifiedTerminalRef.current = true;
      if (progress.phase === "completed") {
        toastManager.add({
          type: "success",
          title: "Update installed",
          description: "The new version is live. Reload to load it.",
        });
      } else {
        toastManager.add({
          type: progress.phase === "failed" ? "error" : "warning",
          title: progress.phase === "failed" ? "Install failed" : "Update not installed",
          description: progress.message,
        });
      }
    }
  }, [installFlow, data, error]);

  // Reset the one-shot terminal-toast guard whenever a new install begins.
  useEffect(() => {
    if (installFlow === null) {
      notifiedTerminalRef.current = false;
    }
  }, [installFlow]);

  // --- install log ----------------------------------------------------------
  // The log lives in a file on the server, so the pane is not tied to the tab
  // that triggered the install: a reload (or a second tab) replays the run out
  // of that file. `live` keeps re-attaching because the restart the install
  // performs tears down this socket, and `lastLine` is what lets the
  // reconnected stream continue rather than restart or go blank.
  const logEvents = useInstallLogStore((s) => s.events);
  const logStreaming = useInstallLogStore((s) => s.streaming);
  const loadedRunId = useInstallLogStore((s) => s.runId);
  const runSubscribe = useAtomCommand(subscribeInstallLog, { reportFailure: false });
  const logViewportRef = useRef<HTMLDivElement | null>(null);

  const installRun = data?.installRun ?? null;
  // While a click is in flight the pane follows that click's run and nothing
  // else; with none in flight it follows whatever the host last recorded.
  const displayRun =
    installFlow === null ? installRun : resolveOwnRun(installFlow.target, installRun);
  const logTail = deriveInstallLogTail({
    installActive: installFlow !== null && !terminalReached,
    run: displayRun,
    loadedRunId,
    dismissedRunId,
  });
  const serverRunId = displayRun?.runId ?? null;

  useEffect(() => {
    if (environmentId === null || logTail === "none" || serverRunId === null) return;
    // Resuming from a stale offset would silently skip the head of a different
    // run, so start that one clean.
    const held = useInstallLogStore.getState().runId;
    if (held !== null && held !== serverRunId) {
      useInstallLogStore.getState().reset();
    }
    let cancelled = false;
    const attach = () => {
      if (cancelled) return;
      const store = useInstallLogStore.getState();
      if (store.streaming) return;
      store.setStreaming(true);
      // Pinned: the tail must not follow the pointer onto another run halfway
      // through, and a reconnect must resume this run rather than the current
      // one.
      void runSubscribe({ environmentId, fromLine: store.lastLine, runId: serverRunId }).finally(
        () => {
          useInstallLogStore.getState().setStreaming(false);
        },
      );
    };
    attach();
    if (logTail === "replay") {
      return () => {
        cancelled = true;
      };
    }
    const interval = window.setInterval(attach, LOG_RESUBSCRIBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [environmentId, logTail, serverRunId, runSubscribe]);

  const handleHideLog = useCallback(() => {
    setDismissedRunId(useInstallLogStore.getState().runId ?? serverRunId);
    useInstallLogStore.getState().reset();
  }, [serverRunId]);

  // Follow the tail. Only auto-scroll when the user is already at the bottom so
  // scrolling back to read a failure is not fought by incoming lines.
  useEffect(() => {
    const node = logViewportRef.current;
    if (node === null) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
    if (atBottom) node.scrollTop = node.scrollHeight;
  }, [logEvents]);

  const handleReload = useCallback(() => {
    window.location.reload();
  }, []);

  const state = data ?? null;
  const supported = state?.supported ?? false;
  // Until the update-state query returns its first result `data` is null, so
  // `supported` defaults to false. Rendering the terminal "In-app updates
  // unavailable" message during that load window and then flipping to the real
  // UI once the query resolves is the confusing two-step flash on open. Only
  // treat the deployment as unavailable once we have a definitive answer; while
  // it is still loading show a neutral loading row instead.
  const hasResolvedUpdateState = data !== null;
  const installActive = installFlow !== null && !(installProgress?.terminal ?? false);
  const canUpdate =
    supported && !installing && !(installFlow !== null && !installProgress?.terminal);

  const installRowStatus = useMemo(() => {
    if (installProgress) {
      const tone =
        installProgress.phase === "completed"
          ? "text-emerald-600 dark:text-emerald-400"
          : installProgress.phase === "failed"
            ? "text-destructive"
            : installProgress.phase === "deferred"
              ? "text-amber-600 dark:text-amber-400"
              : undefined;
      return (
        <span className={cn("inline-flex items-center gap-1.5", tone)}>
          {installProgress.phase === "completed" ? (
            <CheckCircle2Icon className="size-3.5" />
          ) : installProgress.phase === "failed" ? (
            <AlertTriangleIcon className="size-3.5" />
          ) : !installProgress.terminal ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : null}
          {installPhaseLabel(installProgress)}
          {installProgress.message ? ` · ${installProgress.message}` : ""}
        </span>
      );
    }
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5",
          state?.status === "error" && "text-destructive",
          state?.status === "up-to-date" && "text-emerald-600 dark:text-emerald-400",
        )}
      >
        {state?.status === "up-to-date" ? <CheckCircle2Icon className="size-3.5" /> : null}
        {state ? statusLabel(state) : "—"}
        {state?.message ? ` · ${state.message}` : ""}
      </span>
    );
  }, [installProgress, state]);

  const installControl = useMemo(() => {
    if (installProgress?.phase === "completed") {
      return (
        <Button size="xs" variant="default" onClick={handleReload}>
          <RotateCwIcon className="size-3.5" />
          Reload now
        </Button>
      );
    }
    return (
      <Button size="xs" variant="default" disabled={!canUpdate} onClick={handleUpdate}>
        {installActive || installing || state?.status === "installing" ? (
          <Loader2Icon className="size-3.5 animate-spin" />
        ) : (
          <RefreshCwIcon className="size-3.5" />
        )}
        {installActive || installing ? "Updating…" : "Update T3J"}
      </Button>
    );
  }, [
    installProgress?.phase,
    installActive,
    installing,
    canUpdate,
    state?.status,
    handleReload,
    handleUpdate,
  ]);

  return settingsPageShell(
    embedded,
    <SettingsSection title="Updates" icon={<RefreshCwIcon className="size-3.5" />}>
      {isElectron || HOSTED_APP_CHANNEL ? <AboutVersionSection /> : null}
      {!hasResolvedUpdateState ? (
        <SettingsRow
          title="Checking update status…"
          description="Loading this deployment's update configuration."
          control={<Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />}
        />
      ) : !supported ? (
        <SettingsRow
          title="In-app updates unavailable"
          description="This deployment is not configured for in-app updates. Updates are managed by the host."
        />
      ) : (
        <>
          <SettingsRow
            title="Version"
            description={
              <>
                {`v${APP_VERSION} · deployed `}
                <span className="font-mono text-foreground/80">
                  {shortCommit(state?.deployedCommit ?? null)}
                </span>
                {state?.availableCommit &&
                state.availableCommit !== state.deployedCommit &&
                !(
                  state.deployedCommit && state.availableCommit.startsWith(state.deployedCommit)
                ) ? (
                  <>
                    {" · latest "}
                    <span className="font-mono text-foreground/80">
                      {shortCommit(state.availableCommit)}
                    </span>
                  </>
                ) : null}
              </>
            }
            status={installRowStatus}
            control={installControl}
          />
          {logEvents.length > 0 || logTail !== "none" ? (
            <div className="px-3 pb-3">
              <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>
                  Install log
                  {displayRun ? ` · ${displayRun.status} · ${displayRun.phase}` : ""}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  {logTail === "live" && !logStreaming ? (
                    <>
                      <Loader2Icon className="size-3 animate-spin" />
                      reconnecting…
                    </>
                  ) : null}
                  {logEvents.length} lines
                  <Button size="xs" variant="ghost" onClick={handleHideLog}>
                    Hide
                  </Button>
                </span>
              </div>
              <div
                ref={logViewportRef}
                className="max-h-72 overflow-auto rounded border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed"
              >
                {logEvents.length === 0 ? (
                  <div className="text-muted-foreground">
                    {logTail === "live"
                      ? "Waiting for the install log…"
                      : "No log lines were recorded for this run."}
                  </div>
                ) : (
                  logEvents.map((event) => (
                    <div
                      key={`${event.runId}:${event.line}`}
                      className={cn(
                        "whitespace-pre-wrap break-words",
                        event.level === "error" && "text-destructive",
                        event.level === "warn" && "text-amber-600 dark:text-amber-400",
                        event.level === "phase" && "mt-1 font-semibold text-foreground",
                      )}
                    >
                      {event.message}
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : null}
        </>
      )}
    </SettingsSection>,
  );
}
