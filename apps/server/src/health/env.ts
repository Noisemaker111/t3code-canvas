/**
 * The live {@link HealthEnv} — the only place in `health/` that touches the box.
 *
 * @module health/env
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { HealthEnv, HealthPaths } from "./types.ts";

const PATH_SEPARATOR = NodePath.delimiter;

async function exists(path: string): Promise<boolean> {
  try {
    await NodeFSP.access(path, NodeFS.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isWritable(path: string): Promise<boolean> {
  try {
    await NodeFSP.access(path, NodeFS.constants.W_OK);
  } catch {
    return false;
  }
  // A read-only Btrfs mount still passes the W_OK permission check, so prove it
  // with a real write — that failure mode is the whole reason this check exists.
  const probe = NodePath.join(path, `.t3-health-${process.pid}-${Date.now()}`);
  try {
    await NodeFSP.writeFile(probe, "", "utf8");
    return true;
  } catch {
    return false;
  } finally {
    await unlinkQuiet(probe);
  }
}

async function unlinkQuiet(path: string): Promise<void> {
  try {
    await NodeFSP.unlink(path);
  } catch {
    return;
  }
}

async function which(binary: string): Promise<string | null> {
  const raw = process.env["PATH"];
  if (!raw) return null;
  for (const dir of raw.split(PATH_SEPARATOR)) {
    if (!dir) continue;
    const candidate = NodePath.join(dir, binary);
    try {
      await NodeFSP.access(candidate, NodeFS.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

async function reachable(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "HEAD", signal: controller.signal });
    // Any answered request proves egress; the status is the host's business.
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const exec = (
  command: string,
  args: ReadonlyArray<string>,
  options?: { readonly timeoutMs?: number },
): Promise<{ code: number; output: string }> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      { timeout: options?.timeoutMs ?? 120_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim();
        if (!error) return resolve({ code: 0, output });
        const code = typeof error.code === "number" ? error.code : 1;
        resolve({ code, output: output.length > 0 ? output : error.message });
      },
    );
  });

export function makeHealthEnv(paths: HealthPaths): HealthEnv {
  return {
    paths,
    exec,
    nowMs: () => Date.now(),
    nodeVersion: process.versions.node,
    envVar: (name) => {
      const value = process.env[name]?.trim();
      return value && value.length > 0 ? value : null;
    },
    which,
    reachable,
    fs: {
      exists,
      isWritable,
      mkdirp: async (path) => {
        await NodeFSP.mkdir(path, { recursive: true });
      },
      readDir: async (path) => {
        try {
          return await NodeFSP.readdir(path);
        } catch {
          return [];
        }
      },
      readFile: async (path) => {
        try {
          return await NodeFSP.readFile(path, "utf8");
        } catch {
          return null;
        }
      },
      diskSpace: async (path) => {
        try {
          const stats = await NodeFSP.statfs(path);
          return {
            freeBytes: Number(stats.bavail) * Number(stats.bsize),
            totalBytes: Number(stats.blocks) * Number(stats.bsize),
          };
        } catch {
          return null;
        }
      },
    },
  };
}

let boundStateDir: string | null = null;

/**
 * Pin the state directory the server actually resolved, so callers that are not
 * in the config layer graph (the VPS panel, the CLI) still inspect the right
 * box rather than guessing a path.
 */
export function bindHealthStateDir(stateDir: string): void {
  boundStateDir = stateDir.trim().length > 0 ? stateDir : null;
}

/** Paths from the environment the service actually runs with. */
export function healthPathsFromEnvironment(stateDir?: string): HealthPaths {
  const worktreeRoot = process.env["T3CODE_WORKTREE_ROOT"]?.trim();
  const repoRoot = process.env["T3CODE_VPS_REPO_PATH"]?.trim();
  const releaseCurrent = process.env["T3CODE_RELEASE_CURRENT"]?.trim();
  return {
    stateDir:
      stateDir ?? boundStateDir ?? process.env["T3CODE_STATE_DIR"] ?? "/var/lib/t3j/userdata",
    worktreeRoot: worktreeRoot && worktreeRoot.length > 0 ? worktreeRoot : null,
    repoRoot: repoRoot && repoRoot.length > 0 ? repoRoot : null,
    releaseRoot: releaseCurrent && releaseCurrent.length > 0 ? releaseCurrent : null,
  };
}
