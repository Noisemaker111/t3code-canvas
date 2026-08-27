import { ThreadId, type ServerConfig } from "@t3tools/contracts";

import { useCanvasStationStore } from "~/canvasStationStore";

/**
 * Stable client-owned thread id for the Board host console. Terminal sessions
 * are keyed by threadId only — this does not create an orchestration thread.
 */
export const HOST_CONSOLE_THREAD_ID = ThreadId.make("__t3_host_console__");

/**
 * A command waiting for the host console to be on screen.
 *
 * It is parked rather than delivered because the console is usually not mounted
 * when the click happens: the buttons that send commands live in settings, a
 * different station, and a panel nobody has looked at has no body — so there is
 * nothing listening. Parking plus {@link takeHostConsoleCommand} means the
 * console that mounts *afterwards* still finds it.
 */
let parkedCommand: string | null = null;

const listeners = new Set<() => void>();

/**
 * Put a command in the host console: park it, then move the canvas onto the
 * console panel, minting it if the canvas does not have one.
 *
 * The command is preloaded, not run — the human presses Enter.
 */
export function requestHostConsoleCommand(command: string): void {
  const trimmed = command.trim();
  if (trimmed.length === 0) return;
  parkedCommand = trimmed;
  // focus: true — open the host console station so the preloaded command is
  // visible; without focus the panel can mount off-screen and the write is lost.
  useCanvasStationStore
    .getState()
    .requestPanel({ kind: "terminal", entityId: "" }, { focus: true });
  for (const listener of listeners) listener();
}

/** Take the parked command. It is handed out once — whoever takes it owns it. */
export function takeHostConsoleCommand(): string | null {
  const command = parkedCommand;
  parkedCommand = null;
  return command;
}

/** Ping on every request, so a console already on screen drains without a nav. */
export function subscribeHostConsoleCommands(onCommand: () => void): () => void {
  listeners.add(onCommand);
  return () => {
    listeners.delete(onCommand);
  };
}

/** Prefer the host home directory; fall back to the server process cwd. */
export function resolveHostConsoleCwd(
  serverConfig: Pick<ServerConfig, "cwd" | "homeDirectory"> | null | undefined,
): string | null {
  const home = serverConfig?.homeDirectory?.trim();
  if (home) return home;
  const cwd = serverConfig?.cwd?.trim();
  return cwd || null;
}
