/**
 * Hermes tiers 1 and 2 — the `cursor-agent` and `grok` CLIs over ACP. Reuses
 * the ACP runtime plumbing directly rather than growing a generic `complete` on
 * `TextGeneration`, whose methods are task-shaped.
 *
 * The session lives across ticks (`cliSession.ts`); the stateless `complete`
 * opens the same session, asks once and closes it.
 *
 * @module kanban/hermes/acpBackends
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { ProviderDriverKind, type CursorSettings, type GrokSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import type * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import {
  applyCursorAcpModelSelection,
  makeCursorAcpRuntime,
  resolveCursorAgentBinaryPath,
} from "../../provider/acp/CursorAcpSupport.ts";
import {
  applyGrokAcpModelSelection,
  currentGrokModelIdFromSessionSetup,
  makeGrokAcpRuntime,
  resolveGrokAcpBaseModelId,
} from "../../provider/acp/GrokAcpSupport.ts";
import {
  HermesBackendError,
  toAcpModelId,
  type HermesBackend,
  type HermesTier,
  type HermesTierAvailability,
} from "./backend.ts";
import {
  hermesPromptText,
  makeHermesCliSession,
  type HermesCliOpenInput,
  type HermesCliSessionHandle,
} from "./cliSession.ts";

const ACP_TIMEOUT_MS = 180_000;
const ACP_OPEN_RETRY_DELAY_MS = 1_000;

export type AcpBackendDeps = {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly crypto: typeof Crypto.Crypto extends Crypto.Crypto ? never : Crypto.Crypto;
  /** Where the ACP session runs. Hermes never edits files here. */
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  /** Runs a scoped Effect to a promise; the caller owns the runtime. */
  readonly runPromise: <A>(effect: Effect.Effect<A, unknown, never>) => Promise<A>;
  readonly binaryExists?: (command: string) => boolean;
};

/** `command -v` without a subprocess: absolute path, or a PATH entry. */
export function commandOnPath(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = (path) => {
    try {
      return NodeFS.statSync(path).isFile();
    } catch {
      return false;
    }
  },
): boolean {
  if (!command.trim()) return false;
  if (command.includes(NodePath.sep) || command.includes("/")) return exists(command);
  const pathValue = environment.PATH ?? environment.Path ?? "";
  // oxlint-disable-next-line t3code/no-global-process-runtime -- sync helper outside Effect; the PATH probe must match the host that spawns the CLI
  const pathExt = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathValue.split(NodePath.delimiter)) {
    if (!dir) continue;
    for (const ext of pathExt) {
      if (exists(NodePath.join(dir, `${command}${ext}`))) return true;
    }
  }
  return false;
}

function acpError(tier: HermesTier, cause: unknown): HermesBackendError {
  if (cause instanceof HermesBackendError) return cause;
  return new HermesBackendError({
    tier,
    kind: "unavailable",
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

type AcpRuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];

type AcpSessionInput = {
  readonly deps: AcpBackendDeps;
  readonly timeoutLabel: string;
  readonly make: (
    resumeSessionId: string | undefined,
  ) => Effect.Effect<AcpRuntimeService, EffectAcpErrors.AcpError, Crypto.Crypto | Scope.Scope>;
  /** Model and mode selection, once, on the session everything else reuses. */
  readonly configure: (input: {
    readonly runtime: AcpRuntimeService;
    readonly started: AcpSessionRuntime.AcpSessionRuntimeStartResult;
  }) => Effect.Effect<void, EffectAcpErrors.AcpError>;
};

/** Retry only a fresh open; the session owner turns a failed resume into a full-history fresh ask. */
export async function retryFreshAcpOpen<A>(input: {
  readonly resumeSessionId?: string;
  readonly timeoutLabel: string;
  readonly open: () => Promise<A | null>;
  readonly backoff: () => Promise<void>;
}): Promise<A> {
  const first = await input.open();
  if (first !== null) return first;

  if (input.resumeSessionId !== undefined) {
    throw new Error(`${input.timeoutLabel} open timed out`);
  }

  await input.backoff();
  const retried = await input.open();
  if (retried !== null) return retried;
  throw new Error(`${input.timeoutLabel} open timed out after retry`);
}

/** The scope outlives this open; closing the returned handle kills the CLI. */
async function openAcpSession(
  input: AcpSessionInput,
  open: HermesCliOpenInput,
): Promise<HermesCliSessionHandle> {
  return retryFreshAcpOpen({
    ...(open.resumeSessionId === undefined ? {} : { resumeSessionId: open.resumeSessionId }),
    timeoutLabel: input.timeoutLabel,
    open: () => openAcpSessionOnce(input, open),
    backoff: () => input.deps.runPromise(Effect.sleep(ACP_OPEN_RETRY_DELAY_MS)),
  });
}

async function openAcpSessionOnce(
  input: AcpSessionInput,
  open: HermesCliOpenInput,
): Promise<HermesCliSessionHandle | null> {
  const deps = input.deps;
  const scope = await deps.runPromise(Scope.make());
  const closeScope = () =>
    deps.runPromise(Scope.close(scope, Exit.void).pipe(Effect.catchCause(() => Effect.void)));

  try {
    // Open/start/configure used to sit unbound while only `prompt` had a
    // timeout. Live ticks spent 15+ minutes stuck on a hung cursor-agent
    // session/new with busy:true the whole time. Bound the open the same way.
    const session = await deps.runPromise(
      Effect.gen(function* () {
        const outputRef = yield* Ref.make("");
        const runtime = yield* input.make(open.resumeSessionId);
        yield* runtime.handleSessionUpdate((notification) => {
          const update = notification.update;
          if (update.sessionUpdate !== "agent_message_chunk") return Effect.void;
          const content = update.content;
          if (content.type !== "text") return Effect.void;
          return Ref.update(outputRef, (current) => current + content.text);
        });
        const started = yield* runtime.start();
        yield* input.configure({ runtime, started });
        return { sessionId: started.sessionId, runtime, outputRef };
      }).pipe(
        Effect.timeoutOption(ACP_TIMEOUT_MS),
        Effect.provideService(Crypto.Crypto, deps.crypto),
        Effect.provideService(Scope.Scope, scope),
        Effect.catchCause((cause) => Effect.die(new Error(String(cause)))),
      ),
    );

    if (Option.isNone(session)) {
      await closeScope();
      return null;
    }

    const opened = session.value;

    return {
      sessionId: opened.sessionId,
      prompt: (text) =>
        deps.runPromise(
          Effect.gen(function* () {
            yield* Ref.set(opened.outputRef, "");
            yield* opened.runtime.prompt({ prompt: [{ type: "text", text }] });
            return yield* Ref.get(opened.outputRef);
          }).pipe(
            Effect.timeoutOption(ACP_TIMEOUT_MS),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.die(new Error(`${input.timeoutLabel} timed out`)),
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

/** The stateless ask: the same session, opened for one prompt and closed. */
function statelessComplete(tier: HermesTier, session: AcpSessionInput): HermesBackend["complete"] {
  return async (input) => {
    const model = (input.model ?? "").trim();
    const handle = await openAcpSession(session, { model }).catch((cause: unknown) => {
      throw acpError(tier, cause);
    });
    try {
      const text = await handle.prompt(hermesPromptText(input.system, input.user));
      if (!text.trim()) {
        throw new HermesBackendError({
          tier,
          kind: "bad-response",
          message: `${tier} returned empty output`,
        });
      }
      // ACP session updates carry no token counts, so this tier's spend is
      // knowable only as wall clock. The attempt's `durationMs` is that.
      return { text };
    } catch (cause) {
      throw acpError(tier, cause);
    } finally {
      await handle.close();
    }
  };
}

export function makeCursorHermesBackend(
  deps: AcpBackendDeps,
  cursorSettings: Pick<CursorSettings, "apiEndpoint" | "binaryPath"> | null,
): HermesBackend {
  const environment = deps.environment ?? process.env;
  const exists = deps.binaryExists;

  const available = async (): Promise<HermesTierAvailability> => {
    const binary = resolveCursorAgentBinaryPath(cursorSettings?.binaryPath, environment);
    const found = exists ? exists(binary) : commandOnPath(binary, environment);
    return found
      ? { tier: "cursor", available: true, detail: binary }
      : { tier: "cursor", available: false, detail: `missing binary: ${binary}` };
  };

  const session = (model: string): AcpSessionInput => ({
    deps,
    timeoutLabel: "cursor-agent ACP request",
    make: (resumeSessionId) =>
      makeCursorAcpRuntime({
        cursorSettings,
        environment,
        childProcessSpawner: deps.childProcessSpawner,
        cwd: deps.cwd,
        clientInfo: { name: "t3-hermes-brain", version: "0.0.0" },
        ...(resumeSessionId ? { resumeSessionId } : {}),
      }),
    configure: ({ runtime }) =>
      Effect.gen(function* () {
        yield* Effect.ignore(runtime.setMode("ask"));
        yield* applyCursorAcpModelSelection({
          runtime,
          model: toAcpModelId(model),
          // Fast Mode is sticky per-CLI config; without an explicit false a
          // fast tick bills the premium lane no matter what the slider says.
          selections: [{ id: "fastMode", value: false }],
          mapError: (context) => context.cause,
        });
      }),
  });

  const cli = makeHermesCliSession({
    tier: "cursor",
    open: (open) => openAcpSession(session(open.model), open),
  });

  return {
    tier: "cursor",
    driver: ProviderDriverKind.make("cursor"),
    available,
    complete: (input) => statelessComplete("cursor", session((input.model ?? "").trim()))(input),
    ...cli,
  };
}

export function makeXaiHermesBackend(
  deps: AcpBackendDeps,
  grokSettings: Pick<GrokSettings, "binaryPath"> | null,
): HermesBackend {
  const environment = deps.environment ?? process.env;
  const exists = deps.binaryExists;

  const available = async (): Promise<HermesTierAvailability> => {
    const binary = grokSettings?.binaryPath?.trim() || "grok";
    const found = exists ? exists(binary) : commandOnPath(binary, environment);
    if (!found) {
      return { tier: "xai", available: false, detail: `missing binary: ${binary}` };
    }
    // A cached OAuth token also authenticates the CLI, but we cannot read it
    // without spawning; treat a present key as the only signal we can prove.
    return environment.XAI_API_KEY?.trim()
      ? {
          tier: "xai",
          available: true,
          detail: "XAI_API_KEY set (auth unverified until it serves)",
        }
      : {
          tier: "xai",
          available: true,
          detail:
            "binary present — auth unverified; relies on a cached `grok login`, " +
            "set XAI_API_KEY to make this provable",
        };
  };

  const session = (model: string): AcpSessionInput => ({
    deps,
    timeoutLabel: "grok ACP request",
    make: (resumeSessionId) =>
      makeGrokAcpRuntime({
        grokSettings,
        environment,
        childProcessSpawner: deps.childProcessSpawner,
        cwd: deps.cwd,
        clientInfo: { name: "t3-hermes-brain", version: "0.0.0" },
        ...(resumeSessionId ? { resumeSessionId } : {}),
      }),
    configure: ({ runtime, started }) =>
      Effect.asVoid(
        applyGrokAcpModelSelection({
          runtime,
          currentModelId: currentGrokModelIdFromSessionSetup(started.sessionSetupResult),
          requestedModelId: resolveGrokAcpBaseModelId(toAcpModelId(model)),
          mapError: (cause) => cause,
        }),
      ),
  });

  const cli = makeHermesCliSession({
    tier: "xai",
    open: (open) => openAcpSession(session(open.model), open),
  });

  return {
    tier: "xai",
    driver: ProviderDriverKind.make("grok"),
    available,
    complete: (input) => statelessComplete("xai", session((input.model ?? "").trim()))(input),
    ...cli,
  };
}
