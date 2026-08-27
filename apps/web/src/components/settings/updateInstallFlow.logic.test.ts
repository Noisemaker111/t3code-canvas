import type { ServerInstallRun, ServerUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  captureInstallTarget,
  commitsMatch,
  deriveInstallLogTail,
  deriveInstallProgress,
  isServerUpdateRejection,
  SETTLE_MIN_ELAPSED_MS,
  type InstallTarget,
} from "./updateInstallFlow.logic";

const FROM = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TARGET = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function state(overrides: Partial<ServerUpdateState> = {}): ServerUpdateState {
  return {
    supported: true,
    status: "installing",
    deployedCommit: FROM,
    availableCommit: TARGET,
    agentsBusy: false,
    runningAgentCount: 0,
    lastCheckedAt: null,
    message: null,
    installRun: null,
    ...overrides,
  };
}

const RUN_ID = "20260725T120000Z-bbbbbbbbbbbb";
const target: InstallTarget = {
  fromCommit: FROM,
  targetCommit: TARGET,
  fromRunId: null,
  runId: RUN_ID,
};

function run(overrides: Partial<ServerInstallRun> = {}): ServerInstallRun {
  return {
    runId: RUN_ID,
    commit: TARGET,
    phase: "build",
    phaseLabel: "building the release",
    status: "running",
    startedAt: "2026-07-25T12:00:00Z",
    finishedAt: null,
    ...overrides,
  };
}

describe("commitsMatch", () => {
  it("matches a short hash against its full form", () => {
    expect(commitsMatch("bbbbbbb", TARGET)).toBe(true);
    expect(commitsMatch(TARGET, "bbbbbbb")).toBe(true);
  });

  it("rejects different commits and too-short or empty values", () => {
    expect(commitsMatch(FROM, TARGET)).toBe(false);
    expect(commitsMatch("bbbbb", TARGET)).toBe(false);
    expect(commitsMatch(null, TARGET)).toBe(false);
    expect(commitsMatch(TARGET, undefined)).toBe(false);
  });
});

describe("captureInstallTarget", () => {
  it("reads the from/target commits off the state at trigger time", () => {
    expect(captureInstallTarget(state())).toEqual({
      fromCommit: FROM,
      targetCommit: TARGET,
      fromRunId: null,
      runId: null,
    });
    expect(captureInstallTarget(null)).toEqual({
      fromCommit: null,
      targetCommit: null,
      fromRunId: null,
      runId: null,
    });
  });

  it("captures the current run so an old completion cannot satisfy a new click", () => {
    const previous = run({ status: "completed" });
    const captured = captureInstallTarget(state({ installRun: previous }));
    expect(captured.fromRunId).toBe(previous.runId);
    // The run that was already there is not this click's run.
    expect(captured.runId).toBeNull();
  });

  it("adopts the run the host opened for this click", () => {
    const previous = run({ runId: "previous-run", status: "completed" });
    const opened = captureInstallTarget(state({ installRun: previous }));
    const started = captureInstallTarget(
      state({ installRun: run({ runId: "queued-run", phase: "queue" }) }),
      opened,
    );
    expect(started.runId).toBe("queued-run");
    expect(started.fromRunId).toBe("previous-run");
  });
});

describe("isServerUpdateRejection", () => {
  it("distinguishes a server refusal from the expected restart transport loss", () => {
    expect(isServerUpdateRejection({ _tag: "ServerUpdateError", detail: "busy" })).toBe(true);
    expect(isServerUpdateRejection(new Error("WebSocket closed"))).toBe(false);
    expect(isServerUpdateRejection(null)).toBe(false);
  });
});

describe("deriveInstallProgress", () => {
  it("shows building while the server reports installing", () => {
    const progress = deriveInstallProgress(target, {
      state: state({ status: "installing" }),
      reachable: true,
      elapsedMs: 1_000,
    });
    expect(progress.phase).toBe("installing");
    expect(progress.terminal).toBe(false);
  });

  it("shows restarting while the server is unreachable", () => {
    const progress = deriveInstallProgress(target, {
      state: state(),
      reachable: false,
      elapsedMs: 20_000,
    });
    expect(progress.phase).toBe("restarting");
    expect(progress.terminal).toBe(false);
  });

  it("shows restarting before the first poll resolves", () => {
    const progress = deriveInstallProgress(target, {
      state: null,
      reachable: true,
      elapsedMs: 500,
    });
    expect(progress.phase).toBe("restarting");
    expect(progress.terminal).toBe(false);
  });

  it("completes once the running server reports the target commit", () => {
    // A fresh server boots at "idle" with no availableCommit — completion must be
    // detected by the deployed commit advancing, not by the status word.
    const progress = deriveInstallProgress(target, {
      state: state({ status: "idle", deployedCommit: TARGET, availableCommit: null }),
      reachable: true,
      elapsedMs: 30_000,
    });
    expect(progress.phase).toBe("completed");
    expect(progress.terminal).toBe(true);
  });

  it("completes even when the server advertises the commit only in short form", () => {
    const progress = deriveInstallProgress(target, {
      state: state({ status: "idle", deployedCommit: "bbbbbbb", availableCommit: null }),
      reachable: true,
      elapsedMs: 30_000,
    });
    expect(progress.phase).toBe("completed");
  });

  it("completes when the command response was lost but the deployed commit advanced", () => {
    const progress = deriveInstallProgress(
      { fromCommit: FROM, targetCommit: null, fromRunId: null, runId: null },
      {
        state: state({ status: "idle", deployedCommit: TARGET, availableCommit: null }),
        reachable: true,
        elapsedMs: 30_000,
      },
    );
    expect(progress.phase).toBe("completed");
    expect(progress.terminal).toBe(true);
  });

  it("uses a new completed run when neither commit was known before the restart", () => {
    const progress = deriveInstallProgress(
      { fromCommit: null, targetCommit: null, fromRunId: "previous-run", runId: null },
      {
        state: state({
          status: "idle",
          deployedCommit: TARGET,
          availableCommit: null,
          installRun: run({ runId: "new-run", status: "completed", phase: "completed" }),
        }),
        reachable: true,
        elapsedMs: 30_000,
      },
    );
    expect(progress.phase).toBe("completed");
  });

  it("does not let a previous completed run satisfy a new update click", () => {
    const previous = run({ runId: "previous-run", status: "completed", phase: "completed" });
    const progress = deriveInstallProgress(
      { fromCommit: FROM, targetCommit: null, fromRunId: previous.runId, runId: null },
      {
        state: state({
          status: "available",
          deployedCommit: FROM,
          availableCommit: TARGET,
          installRun: previous,
        }),
        reachable: true,
        elapsedMs: 1_000,
      },
    );
    expect(progress.phase).toBe("installing");
    expect(progress.terminal).toBe(false);
  });

  it("surfaces a failed deploy terminally with its message", () => {
    const progress = deriveInstallProgress(target, {
      state: state({ status: "error", message: "deploy failed: pnpm build exited 1" }),
      reachable: true,
      elapsedMs: 30_000,
    });
    expect(progress.phase).toBe("failed");
    expect(progress.terminal).toBe(true);
    expect(progress.message).toContain("pnpm build");
  });

  it("does not mistake the pre-install snapshot for a deferral", () => {
    // Right after trigger the poll can still return the old settled state; it must
    // read as building, not as a finished-without-restart deferral.
    const progress = deriveInstallProgress(target, {
      state: state({ status: "available", deployedCommit: FROM }),
      reachable: true,
      elapsedMs: SETTLE_MIN_ELAPSED_MS - 1,
    });
    expect(progress.phase).toBe("installing");
    expect(progress.terminal).toBe(false);
  });

  it("reports a deferral once settled past the grace window without advancing", () => {
    const progress = deriveInstallProgress(target, {
      state: state({
        status: "available",
        deployedCommit: FROM,
        message: "Install was deferred while agents were running.",
      }),
      reachable: true,
      elapsedMs: SETTLE_MIN_ELAPSED_MS + 1,
    });
    expect(progress.phase).toBe("deferred");
    expect(progress.terminal).toBe(true);
    expect(progress.message).toContain("deferred");
  });
});

describe("deriveInstallProgress with a reported install run", () => {
  it("names the step the host is actually on instead of a generic spinner", () => {
    const progress = deriveInstallProgress(target, {
      state: state({ status: "installing", installRun: run({ phase: "build" }) }),
      reachable: true,
      elapsedMs: 60_000,
    });
    expect(progress.phase).toBe("installing");
    expect(progress.message).toBe("building the release");
    expect(progress.terminal).toBe(false);
  });

  it("maps the restart phase onto the restarting label", () => {
    const progress = deriveInstallProgress(target, {
      state: state({ status: "installing", installRun: run({ phase: "restart" }) }),
      reachable: true,
      elapsedMs: 60_000,
    });
    expect(progress.phase).toBe("restarting");
  });

  it("falls back to the raw phase name for a host that labels nothing", () => {
    const progress = deriveInstallProgress(target, {
      state: state({
        status: "installing",
        installRun: run({ phase: "brand-new-step", phaseLabel: null }),
      }),
      reachable: true,
      elapsedMs: 60_000,
    });
    expect(progress.message).toBe("brand-new-step");
  });

  it("reports a failure the moment the host records one, without waiting to settle", () => {
    const progress = deriveInstallProgress(target, {
      state: state({
        status: "installing",
        message: 'The install failed during "build".',
        installRun: run({ status: "failed", phase: "build" }),
      }),
      reachable: true,
      elapsedMs: 1_000,
    });
    expect(progress.phase).toBe("failed");
    expect(progress.terminal).toBe(true);
    expect(progress.message).toContain("build");
  });

  it("distinguishes a deferral from a failure using the reported status", () => {
    const progress = deriveInstallProgress(target, {
      state: state({ status: "installing", installRun: run({ status: "deferred" }) }),
      reachable: true,
      elapsedMs: 1_000,
    });
    expect(progress.phase).toBe("deferred");
    expect(progress.terminal).toBe(true);
  });

  it("ignores a run that is not the one this click opened", () => {
    // The failure that started all of this: a previous run sitting in the
    // pointer, read as the outcome of a click whose deploy wrote nothing.
    const progress = deriveInstallProgress(target, {
      state: state({
        status: "installing",
        installRun: run({ runId: "previous-run", commit: FROM, status: "failed" }),
      }),
      reachable: true,
      elapsedMs: 1_000,
    });
    expect(progress.phase).toBe("installing");
    expect(progress.terminal).toBe(false);
  });

  it("reads this click's run even before a commit is resolved for it", () => {
    // The run exists from the click; the commit is filled in once the deploy
    // service has fetched.
    const progress = deriveInstallProgress(target, {
      state: state({
        status: "installing",
        installRun: run({
          commit: "",
          phase: "queue",
          phaseLabel: "waiting for the deploy service",
        }),
      }),
      reachable: true,
      elapsedMs: 1_000,
    });
    expect(progress.message).toBe("waiting for the deploy service");
    expect(progress.terminal).toBe(false);
  });

  it("keeps waiting when apply.sh says completed but the server has not come back", () => {
    // The script finishing is not the same as the new build serving: only the
    // deployed commit advancing proves the restart landed.
    const progress = deriveInstallProgress(target, {
      state: state({
        status: "installing",
        deployedCommit: FROM,
        installRun: run({ status: "completed", phase: "completed" }),
      }),
      reachable: true,
      elapsedMs: 1_000,
    });
    expect(progress.terminal).toBe(false);
  });

  it("still works against an older server that does not report a run at all", () => {
    // During an install the new client talks to the pre-upgrade server, whose
    // state has no installRun field.
    const { installRun: _omitted, ...legacy } = state({ status: "installing" });
    const progress = deriveInstallProgress(target, {
      state: legacy as ServerUpdateState,
      reachable: true,
      elapsedMs: 1_000,
    });
    expect(progress.phase).toBe("installing");
    expect(progress.terminal).toBe(false);
  });
});

describe("deriveInstallLogTail", () => {
  const base = {
    installActive: false,
    run: null,
    loadedRunId: null,
    dismissedRunId: null,
  } as const;

  it("replays a failed run the tab never watched — the reload case", () => {
    expect(deriveInstallLogTail({ ...base, run: run({ status: "failed" }) })).toBe("replay");
    expect(deriveInstallLogTail({ ...base, run: run({ status: "deferred" }) })).toBe("replay");
  });

  it("stops replaying once the pane holds that run", () => {
    const failed = run({ status: "failed" });
    expect(deriveInstallLogTail({ ...base, run: failed, loadedRunId: failed.runId })).toBe("none");
  });

  it("follows a run that is still going, even with no local install flow", () => {
    expect(deriveInstallLogTail({ ...base, run: run({ status: "running" }) })).toBe("live");
  });

  it("shows nothing until this install has a run of its own", () => {
    // Attaching with no identified run is what replayed a previous install's
    // build output under a new click.
    expect(deriveInstallLogTail({ ...base, installActive: true })).toBe("none");
  });

  it("follows this install's run, including one that already finished", () => {
    expect(deriveInstallLogTail({ ...base, installActive: true, run: run() })).toBe("live");
    expect(
      deriveInstallLogTail({ ...base, installActive: true, run: run({ status: "completed" }) }),
    ).toBe("live");
  });

  it("leaves a finished install alone so Settings is not a wall of build output", () => {
    expect(deriveInstallLogTail({ ...base, run: run({ status: "completed" }) })).toBe("none");
  });

  it("keeps a hidden run hidden", () => {
    const failed = run({ status: "failed" });
    expect(deriveInstallLogTail({ ...base, run: failed, dismissedRunId: failed.runId })).toBe(
      "none",
    );
  });
});
