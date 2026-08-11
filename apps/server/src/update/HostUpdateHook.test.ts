import { describe, expect, it } from "vite-plus/test";

import { resolveHostUpdateHook } from "./HostUpdateHook.ts";

describe("resolveHostUpdateHook", () => {
  it("reads the command and the optional log dir", () => {
    expect(
      resolveHostUpdateHook({
        T3J_UPDATE_HOOK: "/usr/local/lib/t3j/host-update.sh",
        T3J_UPDATE_LOG_DIR: "/var/lib/t3j/installs",
      }),
    ).toEqual({
      command: "/usr/local/lib/t3j/host-update.sh",
      logDir: "/var/lib/t3j/installs",
    });
  });

  it("keeps the hook without a log dir — the install still runs, it just has no log pane", () => {
    expect(resolveHostUpdateHook({ T3J_UPDATE_HOOK: "/hook" })).toEqual({
      command: "/hook",
      logDir: null,
    });
    expect(resolveHostUpdateHook({ T3J_UPDATE_HOOK: "/hook", T3J_UPDATE_LOG_DIR: "  " })).toEqual({
      command: "/hook",
      logDir: null,
    });
  });

  // No hook is the normal case off a managed host: a desktop build updates
  // itself through the desktop updater and must report `supported: false`
  // rather than trying to run a deploy that does not exist.
  it("returns no hook when none is declared", () => {
    expect(resolveHostUpdateHook({})).toBeNull();
    expect(resolveHostUpdateHook({ T3J_UPDATE_HOOK: "" })).toBeNull();
    expect(resolveHostUpdateHook({ T3J_UPDATE_HOOK: "   " })).toBeNull();
  });
});
