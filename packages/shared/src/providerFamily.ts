/**
 * Provider families — one list, shared by server routing, budget pricing, and
 * the web usage UI.
 *
 * `ProviderInstanceId` slugs are user-defined ("claude_work"), so family
 * membership is a prefix match on the known family ids, never a closed union:
 * an unknown slug maps to itself and stays routable.
 *
 * @module providerFamily
 */

const FAMILY_IDS = ["codex", "grok", "openrouter", "opencode", "cursor"] as const;

/** Map a provider instance id (user slug) to its usage-service family id. */
export function usageProviderIdForInstance(instanceId: string): string {
  const normalized = instanceId.trim().toLowerCase();
  if (
    normalized === "claudeagent" ||
    normalized.startsWith("claude_") ||
    normalized.startsWith("claude-")
  ) {
    return "claude";
  }
  for (const providerId of FAMILY_IDS) {
    if (
      normalized === providerId ||
      normalized.startsWith(`${providerId}_`) ||
      normalized.startsWith(`${providerId}-`)
    ) {
      return providerId;
    }
  }
  return normalized;
}

/** Families whose marginal cost is plan quota, not dollars. */
export const SUBSCRIPTION_FAMILY_IDS: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "cursor",
  "grok",
  "opencode",
]);

export function isSubscriptionFamily(familyId: string): boolean {
  return SUBSCRIPTION_FAMILY_IDS.has(familyId);
}

/** Catalog org prefix per family, for resolving bare CLI model slugs. */
export const FAMILY_ORG_PREFIX: Readonly<Record<string, string>> = {
  claude: "anthropic",
  codex: "openai",
  grok: "x-ai",
  cursor: "",
  opencode: "",
};
