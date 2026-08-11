import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeMode } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * Effective uid of the server process, or `undefined` on platforms without one
 * (Windows). Injectable so tests can exercise the root path anywhere.
 *
 * The uid is wrapped in an object rather than exposed as a bare
 * `number | undefined` Reference on purpose: `Effect.provideService(ref,
 * undefined)` is indistinguishable from "not provided" and falls back to the
 * default, so a bare Reference could never be overridden to the no-uid case in
 * a test — and worse, that test would silently pass or fail depending on the
 * host's real uid (it fails on a root CI/host, our own deployment target). The
 * wrapper makes `{ uid: undefined }` a real, host-independent override.
 */
export const HostProcessUserId = Context.Reference<{ readonly uid: number | undefined }>(
  "server/provider/Drivers/HostProcessUserId",
  {
    defaultValue: () => ({ uid: process.getuid?.() }),
  },
);

const RUNTIME_MODE_TO_PERMISSION: Record<string, PermissionMode> = {
  "auto-accept-edits": "acceptEdits",
  "full-access": "bypassPermissions",
};

export interface ClaudePermissionModeResolution {
  readonly permissionMode: PermissionMode | undefined;
  /** Set when `full-access` was downgraded because the server runs as root. */
  readonly downgradedFrom?: PermissionMode;
}

/**
 * Maps a thread's runtime mode onto the Claude Agent SDK permission mode.
 *
 * `bypassPermissions` makes the SDK pass `--dangerously-skip-permissions`, and
 * the Claude Code CLI hard-refuses that flag under root/sudo ("cannot be used
 * with root/sudo privileges for security reasons"), exiting 1 before it emits
 * any protocol message. The SDK surfaces only "process exited with code 1", so
 * a root deployment sees every `full-access` Claude session die at startup with
 * no actionable error.
 *
 * `IS_SANDBOX` is the CLI's own opt-out for this check. This VPS runs T3J as
 * root by design (it is the control plane for the box) and sets `IS_SANDBOX=1`
 * on the server process and inside the sealed environment containers, so
 * `full-access` keeps working as root — that is the intended, supported path.
 *
 * The downgrade to `acceptEdits` below is a safety net for a root process where
 * `IS_SANDBOX` is somehow unset: rather than every session dying with an opaque
 * "process exited with code 1", edits still auto-apply and command approvals
 * route through the normal in-app permission prompt, and a warning names the
 * exact env var to restore full access.
 *
 * Other providers are unaffected — this constraint is specific to the Claude
 * Code CLI.
 */
export const resolveClaudePermissionMode = Effect.fn("resolveClaudePermissionMode")(function* (
  runtimeMode: RuntimeMode,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ClaudePermissionModeResolution> {
  const permissionMode = RUNTIME_MODE_TO_PERMISSION[runtimeMode];
  if (permissionMode !== "bypassPermissions") {
    return { permissionMode };
  }

  const { uid } = yield* HostProcessUserId;
  if (uid !== 0) {
    return { permissionMode };
  }

  const isSandbox = (environment["IS_SANDBOX"] ?? "").trim();
  if (isSandbox.length > 0 && isSandbox !== "0" && isSandbox !== "false") {
    return { permissionMode };
  }

  yield* Effect.logWarning(
    "Claude Code refuses --dangerously-skip-permissions as root; downgrading this session from full-access to auto-accept-edits. Set IS_SANDBOX=1 on the server process to keep full access.",
    { runtimeMode },
  );
  return { permissionMode: "acceptEdits", downgradedFrom: "bypassPermissions" };
});
