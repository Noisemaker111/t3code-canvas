import { type CursorSettings, type ProviderOptionSelection } from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import {
  CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
  resolveCursorAcpBaseModelId,
  resolveCursorAcpConfigUpdates,
} from "../Layers/CursorProvider.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type CursorAcpRuntimeCursorSettings = Pick<CursorSettings, "apiEndpoint" | "binaryPath">;

export interface CursorAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly cursorSettings: CursorAcpRuntimeCursorSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface CursorAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option" | "set-model";
  readonly configId?: string;
}

const DEFAULT_CURSOR_AGENT_COMMAND = "cursor-agent";

function fileExists(path: string): boolean {
  try {
    return NodeFS.statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the Cursor Agent CLI executable.
 *
 * On Windows, Node cannot `spawnSync`/`execFileSync` `cursor-agent.cmd` without
 * `shell: true` (EINVAL). Prefer an explicit path, then `CURSOR_AGENT_EXECUTABLE`
 * (PE shim from `scripts/windows-cursor-agent-shim.ps1`), then the known
 * install locations under `%LOCALAPPDATA%\cursor-agent`.
 */
export function resolveCursorAgentBinaryPath(
  binaryPath: string | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  // oxlint-disable-next-line t3code/no-global-process-runtime -- injectable default; Effect callers pass HostProcessPlatform
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = binaryPath?.trim();
  if (configured && configured.length > 0 && configured !== DEFAULT_CURSOR_AGENT_COMMAND) {
    return configured;
  }

  const fromEnv = environment.CURSOR_AGENT_EXECUTABLE?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }

  if (platform === "win32") {
    const localAppData =
      environment.LOCALAPPDATA?.trim() || NodePath.win32.join(NodeOS.homedir(), "AppData", "Local");
    const candidates = [
      NodePath.win32.join(localAppData, "cursor-agent", "cursor-agent-shim.exe"),
      NodePath.win32.join(localAppData, "cursor-agent", "cursor-agent.cmd"),
      NodePath.win32.join(localAppData, "cursor-agent", "agent.cmd"),
    ];
    for (const candidate of candidates) {
      if (fileExists(candidate)) {
        return candidate;
      }
    }
  }

  return configured && configured.length > 0 ? configured : DEFAULT_CURSOR_AGENT_COMMAND;
}

export function buildCursorAcpSpawnInput(
  cursorSettings: CursorAcpRuntimeCursorSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  const env = environment ?? process.env;
  return {
    command: resolveCursorAgentBinaryPath(cursorSettings?.binaryPath, env),
    args: [
      ...(cursorSettings?.apiEndpoint ? (["-e", cursorSettings.apiEndpoint] as const) : []),
      "acp",
    ],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeCursorAcpRuntime = (
  input: CursorAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildCursorAcpSpawnInput(input.cursorSettings, input.cwd, input.environment),
        authMethodId: "cursor_login",
        clientCapabilities: CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

interface CursorAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntime.AcpSessionRuntime["Service"]["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export function applyCursorAcpModelSelection<E>(input: {
  readonly runtime: CursorAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: CursorAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    yield* input.runtime.setModel(resolveCursorAcpBaseModelId(input.model)).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          step: "set-model",
        }),
      ),
    );

    const configUpdates = resolveCursorAcpConfigUpdates(
      yield* input.runtime.getConfigOptions,
      input.selections,
    );
    for (const update of configUpdates) {
      yield* input.runtime.setConfigOption(update.configId, update.value).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            step: "set-config-option",
            configId: update.configId,
          }),
        ),
      );
    }
  });
}
