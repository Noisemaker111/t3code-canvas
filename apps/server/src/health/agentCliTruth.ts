/**
 * Honest classification of harness CLIs on PATH.
 * `agent` is often Grok, not Cursor — health must not green-lie as cursor-agent.
 *
 * @module health/agentCliTruth
 */

export type AgentCliKind = "claude" | "codex" | "grok" | "cursor-agent" | "unknown";

export type AgentCliObservation = {
  readonly binary: string;
  readonly path: string;
  /** What the binary actually is after version sniffing. */
  readonly kind: AgentCliKind;
  readonly versionLine: string | null;
  /** True when version probe failed or timed out. */
  readonly versionFailed: boolean;
};

/**
 * Map a binary name + optional `--version` first line to a kind.
 * Prefer explicit binary names; use version text when the binary is the
 * ambiguous `agent` shim (Grok ships as both `grok` and `agent`).
 */
export function classifyAgentBinary(input: {
  readonly binary: string;
  readonly versionLine: string | null;
}): AgentCliKind {
  const name = input.binary.trim().toLowerCase();
  const ver = (input.versionLine ?? "").toLowerCase();

  if (name === "claude" || ver.includes("claude")) return "claude";
  if (name === "codex" || ver.includes("codex")) return "codex";
  if (name === "cursor-agent" || ver.includes("cursor-agent") || ver.includes("cursor agent")) {
    return "cursor-agent";
  }
  if (name === "grok" || ver.includes("grok")) return "grok";
  // Grok's CLI historically also installs as `agent`.
  if (name === "agent" && (ver.includes("grok") || ver.length > 0)) {
    if (ver.includes("cursor")) return "cursor-agent";
    return "grok";
  }
  if (name === "agent") return "unknown";
  return "unknown";
}

export function formatAgentCliDetail(observations: ReadonlyArray<AgentCliObservation>): {
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
} {
  if (observations.length === 0) {
    return {
      status: "fail",
      detail:
        "none of claude, codex, grok, cursor-agent are on PATH — every launch will fail at session start",
    };
  }

  const labels: string[] = [];
  const lies: string[] = [];
  let versionFailed = 0;

  for (const obs of observations) {
    const label =
      obs.kind === "unknown"
        ? `${obs.binary} (unknown)`
        : obs.binary === obs.kind
          ? obs.binary
          : `${obs.binary}→${obs.kind}`;
    labels.push(obs.versionFailed ? `${label}?` : label);
    if (obs.versionFailed) versionFailed += 1;
    if (obs.binary === "cursor-agent" && obs.kind !== "cursor-agent") {
      lies.push(`${obs.binary} is ${obs.kind}, not Cursor`);
    }
    if (obs.binary === "agent" && obs.kind === "grok") {
      // Informative, not a lie — still list it as grok.
    }
  }

  const hasAnyHarness = observations.some(
    (o) =>
      o.kind === "claude" || o.kind === "codex" || o.kind === "grok" || o.kind === "cursor-agent",
  );
  if (!hasAnyHarness) {
    return {
      status: "fail",
      detail: `binaries present but none classified as a harness (${labels.join(", ")})`,
    };
  }

  const detail = labels.join(", ");
  if (lies.length > 0) {
    return {
      status: "warn",
      detail: `${detail} — ${lies.join("; ")}`,
    };
  }
  if (versionFailed > 0 && observations.every((o) => o.versionFailed)) {
    return {
      status: "warn",
      detail: `${detail} — version probes failed; PATH entry alone is not proof the CLI can serve`,
    };
  }
  return { status: "ok", detail };
}

/** Binaries we look for on PATH (including the ambiguous `agent` alias). */
export const AGENT_CLI_BINARIES = ["claude", "codex", "grok", "cursor-agent", "agent"] as const;
