import { beforeEach, describe, expect, it } from "@effect/vitest";

import { useCanvasStationStore } from "~/canvasStationStore";
import {
  HOST_CONSOLE_THREAD_ID,
  requestHostConsoleCommand,
  resolveHostConsoleCwd,
  subscribeHostConsoleCommands,
  takeHostConsoleCommand,
} from "./hostConsole";

describe("resolveHostConsoleCwd", () => {
  it("prefers homeDirectory over process cwd", () => {
    expect(
      resolveHostConsoleCwd({
        cwd: "/opt/t3j/current/apps/server",
        homeDirectory: "/root",
      }),
    ).toBe("/root");
  });

  it("falls back to server cwd when home is missing", () => {
    expect(
      resolveHostConsoleCwd({
        cwd: "/opt/t3j/current/apps/server",
      }),
    ).toBe("/opt/t3j/current/apps/server");
  });

  it("returns null when neither path is available", () => {
    expect(resolveHostConsoleCwd(null)).toBeNull();
    expect(resolveHostConsoleCwd(undefined)).toBeNull();
    expect(resolveHostConsoleCwd({ cwd: "   " })).toBeNull();
  });
});

describe("HOST_CONSOLE_THREAD_ID", () => {
  it("is a stable synthetic thread id", () => {
    expect(HOST_CONSOLE_THREAD_ID).toBe("__t3_host_console__");
  });
});

describe("requestHostConsoleCommand", () => {
  beforeEach(() => {
    takeHostConsoleCommand();
    useCanvasStationStore.getState().requestPanel(null);
  });

  it("parks the command for a console that mounts afterwards", () => {
    requestHostConsoleCommand("npm install -g opencode-ai@latest");
    expect(takeHostConsoleCommand()).toBe("npm install -g opencode-ai@latest");
  });

  it("hands the command out once", () => {
    requestHostConsoleCommand("codex login");
    expect(takeHostConsoleCommand()).toBe("codex login");
    expect(takeHostConsoleCommand()).toBeNull();
  });

  it("puts the host console on screen, or the command lands where nobody looks", () => {
    requestHostConsoleCommand("claude auth login");
    const panel = useCanvasStationStore.getState().requestedPanel;
    expect(panel?.ref).toEqual({
      kind: "terminal",
      entityId: "",
    });
    expect(panel?.focus).toBe(true);
  });

  it("pings a console that is already mounted", () => {
    let pings = 0;
    const unsubscribe = subscribeHostConsoleCommands(() => {
      pings += 1;
    });
    requestHostConsoleCommand("grok auth login");
    unsubscribe();
    requestHostConsoleCommand("grok auth login");
    expect(pings).toBe(1);
  });

  it("ignores a blank command", () => {
    requestHostConsoleCommand("   ");
    expect(takeHostConsoleCommand()).toBeNull();
    expect(useCanvasStationStore.getState().requestedPanel).toBeNull();
  });
});
