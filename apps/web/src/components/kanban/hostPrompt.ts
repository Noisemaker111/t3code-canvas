/** Machine root — host threads run here with no worktree. */
export const HOST_ROOT_PATH = "/";

export const HOST_PROJECT_TITLE = "Host root";

export type HostPrompt = {
  readonly isHost: boolean;
  readonly text: string;
};

/** `! fix cursor-agent` → a host thread at `/`; anything else goes to Hermes. */
export function parseHostPrompt(prompt: string): HostPrompt {
  const trimmed = prompt.trimStart();
  if (!trimmed.startsWith("!")) return { isHost: false, text: prompt.trim() };
  return { isHost: true, text: trimmed.slice(1).trim() };
}

export function deriveHostThreadTitle(text: string): string {
  const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? "";
  const collapsed = firstLine.trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) return "Host thread";
  return collapsed.length > 60 ? `${collapsed.slice(0, 59).trimEnd()}…` : collapsed;
}
