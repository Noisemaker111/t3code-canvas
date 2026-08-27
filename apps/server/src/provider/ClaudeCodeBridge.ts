// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// oxlint-disable t3code/namespace-node-imports -- this standalone process boundary uses Node's direct APIs
// oxlint-disable t3code/no-global-process-runtime -- executable discovery and process cleanup must use the host runtime
/**
 * Boundary to the user's installed, official Claude Code CLI.
 *
 * This module deliberately does not read Claude credentials. Claude Code owns
 * authentication and receives only its normal environment and workspace.
 */
import { spawn, execFile } from "node:child_process";
import { accessSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { delimiter, isAbsolute, join, resolve, win32 } from "node:path";

export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "dontAsk"
  | "bypassPermissions";

export interface ClaudeCodeBridgeOptions {
  readonly cwd: string;
  readonly prompt: string;
  readonly sessionKey?: string;
  readonly resume?: boolean;
  readonly executable?: string;
  /** Test seam for a fake CLI; production callers leave this unset. */
  readonly executableArgs?: ReadonlyArray<string>;
  readonly model?: string;
  readonly permissionMode?: ClaudePermissionMode;
  readonly allowBypassPermissions?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly onEvent?: (event: ClaudeCodeEvent) => void;
}

export type ClaudeCodeEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool"; readonly name: string; readonly input?: unknown }
  | { readonly type: "status"; readonly status: string }
  | { readonly type: "result"; readonly result: string }
  | { readonly type: "raw"; readonly value: unknown };

export interface ClaudeCodeResult {
  readonly sessionId: string | null;
  readonly text: string;
  readonly exitCode: number;
  readonly events: ReadonlyArray<ClaudeCodeEvent>;
}

export class ClaudeCodeBridgeError extends Error {
  readonly code:
    | "not-found"
    | "not-authenticated"
    | "invalid-config"
    | "timeout"
    | "cancelled"
    | "process"
    | "protocol";
  constructor(code: ClaudeCodeBridgeError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClaudeCodeBridgeError";
    this.code = code;
  }
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const SESSION_FILE = ".opencode/claude-code-sessions.json";
const SAFE_ENV_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "CLAUDE_CONFIG_DIR",
] as const;
const MODES: ReadonlySet<ClaudePermissionMode> = new Set([
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
]);

function isSessionMap(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

export function redactClaudeOutput(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key|token|secret|password)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]");
}

/** Parse one documented Claude stream-json record without trusting its shape. */
export function parseClaudeEvent(
  line: string,
  sawDelta = false,
): { readonly event: ClaudeCodeEvent | null; readonly isDelta: boolean } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { event: null, isDelta: sawDelta };
  }
  if (!value || typeof value !== "object") return { event: null, isDelta: sawDelta };
  const record = value as Record<string, unknown>;
  if (record.type === "stream_event") {
    const event = record.event as Record<string, unknown> | undefined;
    const delta = event?.delta as Record<string, unknown> | undefined;
    if (
      event?.type === "content_block_delta" &&
      delta?.type === "text_delta" &&
      typeof delta.text === "string"
    ) {
      return { event: { type: "text", text: delta.text }, isDelta: true };
    }
  }
  if (record.type === "assistant" && !sawDelta) {
    const content = (record.message as Record<string, unknown> | undefined)?.content;
    if (Array.isArray(content)) {
      const text = content
        .flatMap((block) =>
          block &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string"
            ? [(block as Record<string, string>).text]
            : [],
        )
        .join("");
      if (text) return { event: { type: "text", text }, isDelta: false };
    }
  }
  if (record.type === "result" && typeof record.result === "string")
    return { event: { type: "result", result: record.result }, isDelta: sawDelta };
  if (record.type === "tool_use" && typeof record.name === "string")
    return { event: { type: "tool", name: record.name, input: record.input }, isDelta: sawDelta };
  if (typeof record.type === "string")
    return { event: { type: "status", status: record.type }, isDelta: sawDelta };
  return { event: { type: "raw", value }, isDelta: sawDelta };
}

export function resolveClaudeExecutable(
  input: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const requested = input?.trim() || "claude";
  if (isAbsolute(requested)) {
    try {
      accessSync(requested);
      return resolve(requested);
    } catch {
      return null;
    }
  }
  const pathValue = environment.PATH ?? environment.Path ?? "";
  const extensions =
    process.platform === "win32" ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const directory of pathValue.split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(directory, requested + (win32.extname(requested) ? "" : extension));
      try {
        accessSync(candidate);
        return resolve(candidate);
      } catch {
        /* continue */
      }
    }
  }
  return null;
}

export function buildClaudeCodeEnvironment(
  input: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    SAFE_ENV_KEYS.flatMap((key) => (input[key] === undefined ? [] : [[key, input[key]]])),
  ) as NodeJS.ProcessEnv;
}

async function sessionIdFor(cwd: string, key: string, resume: boolean): Promise<string | null> {
  if (!key) return null;
  const file = join(cwd, SESSION_FILE);
  let sessions: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (isSessionMap(parsed)) sessions = parsed;
  } catch {
    /* first use */
  }
  if (resume && sessions[key]) return sessions[key];
  const id = randomUUID();
  await mkdir(resolve(file, ".."), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...sessions, [key]: id }, null, 2), { mode: 0o600 });
  await rename(temporary, file);
  return id;
}

async function waitForClose(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolveWait) => {
    const timer = setTimeout(resolveWait, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolveWait();
    });
  });
}

async function killOwnedTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.killed || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    await new Promise<void>((resolveKill) => {
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => resolveKill());
    });
    child.kill();
    await waitForClose(child, 1_000);
    return;
  }
  if (child.pid) {
    try {
      // The child is detached, so its negative pid is the owned process group.
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await waitForClose(child, 1_000);
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      await waitForClose(child, 1_000);
    }
    return;
  }
  child.kill("SIGTERM");
}

export async function runClaudeCode(options: ClaudeCodeBridgeOptions): Promise<ClaudeCodeResult> {
  const mode = options.permissionMode ?? "default";
  if (!MODES.has(mode) || (mode === "bypassPermissions" && options.allowBypassPermissions !== true))
    throw new ClaudeCodeBridgeError(
      "invalid-config",
      "Claude Code permission mode is not allowed by default.",
    );
  if (!options.prompt.trim())
    throw new ClaudeCodeBridgeError("invalid-config", "Claude Code prompt must not be empty.");
  const executable = resolveClaudeExecutable(options.executable, {
    ...process.env,
    ...options.env,
  });
  if (!executable)
    throw new ClaudeCodeBridgeError(
      "not-found",
      "Claude Code CLI was not found. Install it and authenticate with Claude Code normally.",
    );
  const sessionId = await sessionIdFor(
    options.cwd,
    options.sessionKey ?? "",
    options.resume === true,
  );
  const args = [
    ...(options.executableArgs ?? []),
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    mode,
    ...(options.model ? ["--model", options.model] : []),
    ...(sessionId ? [options.resume ? "--resume" : "--session-id", sessionId] : []),
  ];
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: buildClaudeCodeEnvironment({ ...process.env, ...options.env }),
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events: ClaudeCodeEvent[] = [];
  let text = "";
  let stderr = "";
  let stdoutBytes = 0;
  let sawDelta = false;
  let remainder = "";
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => (cleanupPromise ??= killOwnedTree(child));
  const emit = (line: string) => {
    const parsed = parseClaudeEvent(line, sawDelta);
    sawDelta = parsed.isDelta;
    if (parsed.event) {
      events.push(parsed.event);
      options.onEvent?.(parsed.event);
      if (parsed.event.type === "text") text += parsed.event.text;
    }
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > MAX_OUTPUT_BYTES) {
      void cleanup();
      return;
    }
    remainder += chunk.toString("utf8");
    const lines = remainder.split(/\r?\n/);
    remainder = lines.pop() ?? "";
    lines.forEach(emit);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-MAX_OUTPUT_BYTES);
  });
  child.stdin.end(options.prompt);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void cleanup();
  }, timeoutMs);
  const abort = () => void cleanup();
  options.signal?.addEventListener("abort", abort, { once: true });
  const exitPromise = new Promise<{ readonly code: number; readonly error?: Error }>(
    (resolveExit) => {
      let error: Error | undefined;
      child.once("error", (cause) => {
        error = cause;
      });
      child.once("close", (value) =>
        resolveExit(error === undefined ? { code: value ?? 1 } : { code: value ?? 1, error }),
      );
    },
  );
  const code = await Promise.race([
    exitPromise,
    new Promise<null>((resolveExit) => setTimeout(() => resolveExit(null), 2_000)),
  ]);
  clearTimeout(timer);
  options.signal?.removeEventListener("abort", abort);
  if (timedOut) {
    await cleanupPromise;
    throw new ClaudeCodeBridgeError("timeout", `Claude Code timed out after ${timeoutMs} ms.`);
  }
  if (options.signal?.aborted) {
    await cleanupPromise;
    throw new ClaudeCodeBridgeError("cancelled", "Claude Code run was cancelled.");
  }
  if (code === null) {
    await cleanupPromise;
    throw new ClaudeCodeBridgeError("process", "Claude Code did not exit after cleanup.");
  }
  if (code.error) {
    const detail = redactClaudeOutput(code.error.message);
    throw new ClaudeCodeBridgeError(
      (code.error as NodeJS.ErrnoException).code === "ENOENT" ? "not-found" : "process",
      detail || "Claude Code could not be started.",
      { cause: code.error },
    );
  }
  if (remainder.trim()) emit(remainder);
  if (code.code !== 0) {
    const detail = redactClaudeOutput(stderr).trim();
    const auth = /auth|login|oauth|logged in/i.test(detail);
    throw new ClaudeCodeBridgeError(
      auth ? "not-authenticated" : "process",
      detail || `Claude Code exited with code ${code.code}.`,
    );
  }
  return { sessionId, text, exitCode: code.code, events };
}
