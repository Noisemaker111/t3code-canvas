/**
 * Hermes over Codex — ChatGPT models on the owner's `codex login` subscription.
 *
 * Not ACP: the Codex app-server speaks its own JSON-RPC, so this drives the
 * same `CodexSessionRuntime` the coding threads use. The thread lives across
 * ticks (`cliSession.ts`) and is reattached with `thread/resume`; the stateless
 * `complete` opens the same thread, asks once and closes it.
 *
 * @module kanban/hermes/codexBackend
 */
import * as NodeOS from "node:os";

import { ProviderDriverKind, ThreadId, type CodexSettings } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { expandHomePath } from "../../pathExpansion.ts";
import { resolveCodexLaunchArgs } from "../../provider/Layers/codexLaunchArgs.ts";
import { makeCodexSessionRuntime } from "../../provider/Layers/CodexSessionRuntime.ts";
import { commandOnPath, type AcpBackendDeps } from "./acpBackends.ts";
import {
  HermesBackendError,
  toAcpModelId,
  type HermesBackend,
  type HermesTierAvailability,
} from "./backend.ts";
import {
  hermesPromptText,
  makeHermesCliSession,
  type HermesCliOpenInput,
  type HermesCliSessionHandle,
} from "./cliSession.ts";

const CODEX_TIMEOUT_MS = 180_000;

export type CodexHermesSettings = Pick<
  CodexSettings,
  "binaryPath" | "homePath" | "shadowHomePath" | "launchArgs"
>;

/** ACP deps plus the `codex login` auth probe, injected the way `binaryExists` is. */
export type CodexBackendDeps = AcpBackendDeps & {
  /** True when `auth.json` is a readable file at that path. */
  readonly codexAuthExists: (path: string) => Promise<boolean>;
};

/** Where `codex login` writes `auth.json` for this instance's configuration. */
function codexHomeDir(
  settings: CodexHermesSettings | null,
  environment: NodeJS.ProcessEnv,
): string {
  const configured = settings?.shadowHomePath?.trim() || settings?.homePath?.trim() || "";
  if (configured) return expandHomePath(configured);
  const fromEnvironment = environment.CODEX_HOME?.trim();
  if (fromEnvironment) return expandHomePath(fromEnvironment);
  return `${NodeOS.homedir()}/.codex`;
}

/** The turn failed on Codex's side; the status rides the completion payload. */
function failedTurnMessage(payload: unknown): string | null {
  const turn = (payload as { turn?: { status?: unknown; error?: { message?: unknown } } } | null)
    ?.turn;
  if (!turn || turn.status !== "failed") return null;
  const message = turn.error?.message;
  return typeof message === "string" && message.length > 0 ? message : "codex turn failed";
}

function errorNotificationMessage(payload: unknown): string | null {
  const error = (payload as { error?: { message?: unknown } } | null)?.error;
  const message = error?.message;
  return typeof message === "string" && message.length > 0 ? message : null;
}

/** The app-server's own thread id — what `thread/resume` reattaches to. */
function codexThreadIdOf(resumeCursor: unknown): string | null {
  if (resumeCursor === null || typeof resumeCursor !== "object") return null;
  const threadId = (resumeCursor as { threadId?: unknown }).threadId;
  return typeof threadId === "string" && threadId.length > 0 ? threadId : null;
}

let threadSeq = 0;

/**
 * Open one Codex thread and hand back the three things a Hermes session needs.
 * The scope outlives this call — closing the handle is what kills the CLI.
 *
 * Codex answers a turn in deltas and is only done when it says so, so a reply
 * is awaited on a per-turn deferred rather than read off `sendTurn`, which
 * returns as soon as the turn starts.
 */
async function openCodexSession(input: {
  readonly deps: CodexBackendDeps;
  readonly settings: CodexHermesSettings | null;
  readonly open: HermesCliOpenInput;
}): Promise<HermesCliSessionHandle> {
  const deps = input.deps;
  const environment = deps.environment ?? process.env;
  const homePath = input.settings?.shadowHomePath?.trim() || input.settings?.homePath?.trim() || "";
  const model = toAcpModelId(input.open.model);
  const scope = await deps.runPromise(Scope.make());
  const closeScope = () =>
    deps.runPromise(Scope.close(scope, Exit.void).pipe(Effect.catchCause(() => Effect.void)));

  try {
    const session = await deps.runPromise(
      Effect.gen(function* () {
        threadSeq += 1;
        const startedAtMs = yield* Clock.currentTimeMillis;
        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make(`hermes-brain-${startedAtMs}-${threadSeq}`),
          binaryPath: input.settings?.binaryPath?.trim() || "codex",
          ...(homePath ? { homePath } : {}),
          launchArgs: resolveCodexLaunchArgs(input.settings?.launchArgs, environment),
          environment,
          cwd: deps.cwd,
          // Hermes writes to the board through its own API, never to the box.
          runtimeMode: "approval-required",
          model,
          ...(input.open.resumeSessionId
            ? { resumeCursor: { threadId: input.open.resumeSessionId } }
            : {}),
        });

        const outputRef = yield* Ref.make("");
        const turnRef = yield* Ref.make<Deferred.Deferred<void, Error> | null>(null);
        const finishTurn = (failure: Error | null) =>
          Ref.get(turnRef).pipe(
            Effect.flatMap((deferred) =>
              deferred === null
                ? Effect.void
                : Effect.asVoid(
                    failure === null
                      ? Deferred.succeed(deferred, undefined)
                      : Deferred.fail(deferred, failure),
                  ),
            ),
          );

        yield* Effect.forkScoped(
          Stream.runForEach(runtime.events, (event) => {
            if (event.method === "item/agentMessage/delta") {
              const delta = event.textDelta ?? "";
              return delta.length === 0
                ? Effect.void
                : Ref.update(outputRef, (current) => current + delta);
            }
            if (event.method === "turn/completed") {
              const failure = failedTurnMessage(event.payload);
              return finishTurn(failure === null ? null : new Error(failure));
            }
            if (event.method === "error") {
              const message = errorNotificationMessage(event.payload) ?? "codex reported an error";
              return finishTurn(new Error(message));
            }
            // Hermes only ever asks a question; a turn that wants to touch the
            // box is a turn that has misread its prompt, so it is told no.
            if (event.kind === "request" && event.requestId) {
              return Effect.ignore(runtime.respondToRequest(event.requestId, "decline"));
            }
            return Effect.void;
          }),
        );

        const started = yield* runtime.start();
        const threadId = codexThreadIdOf(started.resumeCursor);
        if (threadId === null) {
          return yield* Effect.die(
            new Error("codex app-server started a thread with no resumable id"),
          );
        }
        return { threadId, runtime, outputRef, turnRef };
      }).pipe(
        Effect.provideService(Crypto.Crypto, deps.crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, deps.childProcessSpawner),
        Effect.provideService(Scope.Scope, scope),
        Effect.catchCause((cause) => Effect.die(new Error(String(cause)))),
      ),
    );

    return {
      sessionId: session.threadId,
      prompt: (text) =>
        deps.runPromise(
          Effect.gen(function* () {
            const completed = yield* Deferred.make<void, Error>();
            yield* Ref.set(session.outputRef, "");
            yield* Ref.set(session.turnRef, completed);
            yield* session.runtime.sendTurn({ input: text, model });
            yield* Deferred.await(completed);
            return yield* Ref.get(session.outputRef);
          }).pipe(
            Effect.ensuring(Ref.set(session.turnRef, null)),
            Effect.timeoutOption(CODEX_TIMEOUT_MS),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.die(new Error("codex app-server request timed out")),
                onSome: Effect.succeed,
              }),
            ),
            Effect.catchCause((cause) => Effect.die(new Error(String(cause)))),
          ),
        ),
      close: async () => {
        await closeScope();
      },
    };
  } catch (cause) {
    await closeScope();
    throw cause;
  }
}

/**
 * The Codex transport. `available` proves the binary and a completed
 * `codex login` — an unauthenticated CLI fails the tick with that reason rather
 * than being asked and timing out on a login prompt.
 */
export function makeCodexHermesBackend(
  deps: CodexBackendDeps,
  codexSettings: CodexHermesSettings | null,
): HermesBackend {
  const environment = deps.environment ?? process.env;
  const exists = deps.binaryExists;

  const available = async (): Promise<HermesTierAvailability> => {
    const binary = codexSettings?.binaryPath?.trim() || "codex";
    const found = exists ? exists(binary) : commandOnPath(binary, environment);
    if (!found) return { tier: "codex", available: false, detail: `missing binary: ${binary}` };
    const home = codexHomeDir(codexSettings, environment);
    const authPath = `${home}/auth.json`;
    return (await deps.codexAuthExists(authPath))
      ? { tier: "codex", available: true, detail: `${binary} · ${authPath}` }
      : {
          tier: "codex",
          available: false,
          detail: `no ${authPath} — run \`codex login\` for this CODEX_HOME`,
        };
  };

  const open = (input: HermesCliOpenInput) =>
    openCodexSession({ deps, settings: codexSettings, open: input });

  const complete: HermesBackend["complete"] = async (input) => {
    const handle = await open({ model: (input.model ?? "").trim() }).catch((cause: unknown) => {
      throw new HermesBackendError({
        tier: "codex",
        kind: "unavailable",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
    });
    try {
      const turn = await handle.prompt(hermesPromptText(input.system, input.user));
      if (!turn.trim()) {
        throw new HermesBackendError({
          tier: "codex",
          kind: "bad-response",
          message: "codex returned empty output",
        });
      }
      return { text: turn };
    } catch (cause) {
      if (cause instanceof HermesBackendError) throw cause;
      throw new HermesBackendError({
        tier: "codex",
        kind: "unavailable",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
    } finally {
      await handle.close();
    }
  };

  return {
    tier: "codex",
    driver: ProviderDriverKind.make("codex"),
    available,
    complete,
    ...makeHermesCliSession({ tier: "codex", open }),
  };
}
