import { extractAuthBoolean } from "./providerSnapshot.ts";

function hasEmptyOAuthTokens(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const accessToken = record.accessToken;
  const refreshToken = record.refreshToken;
  if (
    typeof accessToken === "string" &&
    typeof refreshToken === "string" &&
    accessToken.trim().length === 0 &&
    refreshToken.trim().length === 0
  ) {
    return true;
  }
  return Object.values(record).some(hasEmptyOAuthTokens);
}

/** Parse Claude auth status and reject a logged-in OAuth record with no tokens. */
export function parseClaudeAuthLoggedIn(output: string): boolean | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    if (extractAuthBoolean(parsed) !== true) return extractAuthBoolean(parsed);
    return !hasEmptyOAuthTokens(parsed);
  } catch {
    return undefined;
  }
}
