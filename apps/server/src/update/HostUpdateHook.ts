/**
 * HostUpdateHook — the app's entire knowledge of how its host updates itself.
 *
 * Before this module the server ran the deploy itself: it shelled out to `git`
 * in a checkout path it hardcoded, read `/opt/t3j/deployed-commit`, resolved a
 * release symlink and started a named systemd unit. That made the app
 * un-runnable anywhere the VPS layout did not exist — a desktop build reported
 * `supported: false` and the whole update surface went dead.
 *
 * The app now knows one thing: a command. The host declares it in
 * `T3J_UPDATE_HOOK` and owns everything behind it — git, systemd, packages,
 * release layout, none of which appear here.
 *
 * Hook contract (three subcommands, opaque version strings):
 *  - `<hook> current`  → prints the running version to stdout
 *  - `<hook> check`    → prints the newest available version to stdout
 *  - `<hook> install`  → starts the install and returns promptly, printing the
 *                        id of the run it opened; the install is expected to
 *                        replace and restart this process
 *
 * A non-zero exit is an error and stderr is shown to the user. `install` is
 * invoked with `T3J_UPDATE_FORCE=1` when the user has authorized a restart
 * over the host's own safety deferrals.
 *
 * `T3J_UPDATE_LOG_DIR` is the second half of the contract: a directory the
 * hook writes `current.json` plus `<runId>.jsonl` into (see `installLog.ts`).
 * It is optional — without it the install still runs, it just has no log pane.
 *
 * A hook that opens the run itself prints the run id from `install`, which is
 * what lets the app tell the run this click started from the run that happened
 * to be there before it. A hook that prints nothing is still valid; the app
 * then falls back to reconciling the install from its own observations.
 *
 * @module update/HostUpdateHook
 */
import { ServerUpdateError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

const READ_TIMEOUT = Duration.seconds(30);
// `check` may fetch over the network. A slow link used to turn a routine check
// into a hard error at 30s.
const CHECK_TIMEOUT = Duration.seconds(120);
const MAX_OUTPUT_BYTES = 256 * 1024;

const isServerUpdateError = Schema.is(ServerUpdateError);

export interface HostUpdateHookConfig {
  /** Executable the app invokes with `current` / `check` / `install`. */
  readonly command: string;
  /** Directory the hook writes its run log into, or null when it writes none. */
  readonly logDir: string | null;
}

/**
 * Read the hook config out of an environment. Returns null when no hook is
 * declared, which is the normal case for a desktop build or local dev: the app
 * simply reports that the host owns updates.
 */
export function resolveHostUpdateHook(
  env: Readonly<Record<string, string | undefined>>,
): HostUpdateHookConfig | null {
  const command = (env["T3J_UPDATE_HOOK"] ?? "").trim();
  if (command === "") return null;
  const logDir = (env["T3J_UPDATE_LOG_DIR"] ?? "").trim();
  return { command, logDir: logDir === "" ? null : logDir };
}

export class HostUpdateHook extends Context.Service<
  HostUpdateHook,
  {
    /** False when no hook is declared; every other method then fails. */
    readonly supported: boolean;
    /** Directory holding the hook's run log, when it keeps one. */
    readonly logDir: string | null;
    /** Version the host is running, or null when the hook cannot name one. */
    readonly currentVersion: Effect.Effect<string | null, ServerUpdateError>;
    /** Newest version the host could install, or null when it cannot name one. */
    readonly checkVersion: Effect.Effect<string | null, ServerUpdateError>;
    /**
     * Start the install. Returns as soon as the hook has accepted it, with the
     * run id the hook opened for it, or null when the hook names no run.
     */
    readonly startInstall: (options: {
      readonly force: boolean;
    }) => Effect.Effect<string | null, ServerUpdateError>;
  }
>()("t3/update/HostUpdateHook") {}

export const make = (config: HostUpdateHookConfig | null) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const unsupported = (operation: string) =>
      Effect.fail(
        new ServerUpdateError({
          operation,
          detail: "This build has no host update hook. Updates are managed by the host.",
        }),
      );

    const run = (
      subcommand: string,
      options: {
        readonly timeout: Duration.Duration;
        readonly env?: Readonly<Record<string, string>>;
      },
    ): Effect.Effect<string, ServerUpdateError> =>
      config === null
        ? unsupported(subcommand)
        : Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make(config.command, [subcommand], {
                env: options.env === undefined ? undefined : { ...process.env, ...options.env },
              }),
            );
            const [stdout, stderr, exitCode] = yield* Effect.all(
              [
                collectUint8StreamText({ stream: child.stdout, maxBytes: MAX_OUTPUT_BYTES }),
                collectUint8StreamText({ stream: child.stderr, maxBytes: MAX_OUTPUT_BYTES }),
                child.exitCode,
              ],
              { concurrency: "unbounded" },
            );
            if (exitCode !== 0) {
              return yield* Effect.fail(
                new ServerUpdateError({
                  operation: subcommand,
                  detail:
                    stderr.text.trim() ||
                    stdout.text.trim() ||
                    `The update hook exited ${exitCode}.`,
                }),
              );
            }
            return stdout.text.trim();
          }).pipe(
            Effect.scoped,
            Effect.timeout(options.timeout),
            Effect.mapError((cause) =>
              isServerUpdateError(cause)
                ? cause
                : new ServerUpdateError({
                    operation: subcommand,
                    detail: `The update hook (\`${config.command} ${subcommand}\`) did not complete.`,
                    cause,
                  }),
            ),
          );

    // An empty line is a legitimate "I cannot name a version" from a host that
    // has never deployed, not a failure.
    const nonEmpty = (text: string): string | null => (text === "" ? null : text);

    return HostUpdateHook.of({
      supported: config !== null,
      logDir: config?.logDir ?? null,
      currentVersion: run("current", { timeout: READ_TIMEOUT }).pipe(Effect.map(nonEmpty)),
      checkVersion: run("check", { timeout: CHECK_TIMEOUT }).pipe(Effect.map(nonEmpty)),
      startInstall: ({ force }) =>
        run("install", {
          timeout: READ_TIMEOUT,
          env: force ? { T3J_UPDATE_FORCE: "1" } : {},
        }).pipe(Effect.map(nonEmpty)),
    });
  });

export const layer = Layer.effect(HostUpdateHook, make(resolveHostUpdateHook(process.env)));
