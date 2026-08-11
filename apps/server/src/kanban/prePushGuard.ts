/**
 * What must not leave the box, checked before the board commits it.
 *
 * The agent never runs git — the board commits everything in the card's
 * worktree and pushes it. That is the whole point of the arrangement, and it
 * also means a stray `.env`, a dumped token or a 200MB core file reaches a
 * public remote with nobody in between. "Never commit secrets" was a rule
 * agents were asked to follow, with no mechanism behind it.
 *
 * Patterns are deliberately high-confidence: a guard that cries wolf gets
 * turned off, and a false block costs a card its turn.
 *
 * @module kanban/prePushGuard
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Anything bigger has no business in a source commit. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Read at most this much of a file when looking for a secret. */
const MAX_SCAN_BYTES = 512 * 1024;

export interface PrePushFinding {
  readonly path: string;
  readonly reason: string;
}

const SECRET_PATTERNS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: "a private key block", pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { label: "an AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "a GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { label: "a Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "an Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { label: "an OpenAI API key", pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { label: "a Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: "a private key in an SSH config", pattern: /\bBEGIN OPENSSH PRIVATE KEY\b/ },
];

const SECRET_FILE_NAMES = new Set([".env", "t3j.env", ".npmrc", "id_rsa", "id_ed25519"]);
const SECRET_EXTENSIONS = new Set([".pem", ".p12", ".pfx", ".key", ".keystore"]);
/** `.env.example` is the documented shape of the file, not the file. */
const SAFE_ENV_SUFFIXES = [".example", ".sample", ".template", ".dist"];

export function scanPath(path: string): PrePushFinding | null {
  const base = NodePath.basename(path);
  const lower = base.toLowerCase();
  if (SAFE_ENV_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return null;
  if (SECRET_FILE_NAMES.has(lower) || lower.startsWith(".env.")) {
    return { path, reason: `${base} holds environment secrets and must not be committed` };
  }
  if (SECRET_EXTENSIONS.has(NodePath.extname(lower))) {
    return { path, reason: `${base} looks like a key or certificate file` };
  }
  return null;
}

export function scanContent(path: string, content: string): PrePushFinding | null {
  for (const { label, pattern } of SECRET_PATTERNS) {
    if (pattern.test(content)) return { path, reason: `contains what looks like ${label}` };
  }
  return null;
}

export function scanSize(path: string, sizeBytes: number): PrePushFinding | null {
  if (sizeBytes <= MAX_FILE_BYTES) return null;
  return {
    path,
    reason: `is ${(sizeBytes / (1024 * 1024)).toFixed(1)}MB — too big to commit`,
  };
}

export interface PrePushGuardIo {
  /** Byte size, or `null` when the path cannot be read. */
  readonly size: (absolutePath: string) => Promise<number | null>;
  readonly read: (absolutePath: string, maxBytes: number) => Promise<string | null>;
}

/**
 * One finding per file at most, cheapest check first: a file blocked for its
 * name never gets read.
 */
export async function runPrePushGuard(input: {
  readonly cwd: string;
  readonly paths: ReadonlyArray<string>;
  readonly io: PrePushGuardIo;
}): Promise<ReadonlyArray<PrePushFinding>> {
  const findings: PrePushFinding[] = [];
  for (const path of input.paths) {
    const byName = scanPath(path);
    if (byName) {
      findings.push(byName);
      continue;
    }
    const absolute = NodePath.isAbsolute(path) ? path : NodePath.join(input.cwd, path);
    const size = await input.io.size(absolute);
    if (size === null) continue;
    const bySize = scanSize(path, size);
    if (bySize) {
      findings.push(bySize);
      continue;
    }
    if (size > MAX_SCAN_BYTES) continue;
    const content = await input.io.read(absolute, MAX_SCAN_BYTES);
    if (content === null) continue;
    const byContent = scanContent(path, content);
    if (byContent) findings.push(byContent);
  }
  return findings;
}

export function describePrePushFindings(findings: ReadonlyArray<PrePushFinding>): string {
  return findings.map((finding) => `${finding.path} ${finding.reason}`).join("; ");
}

/** The live IO. Unreadable paths are skipped, never treated as a finding. */
export const prePushGuardIo: PrePushGuardIo = {
  size: async (absolutePath) => {
    try {
      const stats = await NodeFSP.stat(absolutePath);
      return stats.isFile() ? stats.size : null;
    } catch {
      return null;
    }
  },
  read: async (absolutePath, maxBytes) => {
    try {
      const handle = await NodeFSP.open(absolutePath, "r");
      try {
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
        return buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  },
};
