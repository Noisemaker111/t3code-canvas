/**
 * The registry: every failure mode the box knows how to find in itself.
 *
 * Each entry is one incident we have actually had (or watched an agent burn a
 * turn on): a full disk that flips the Btrfs store read-only, a worktree that
 * came from the git fallback and therefore has no dependencies, a blocked
 * egress host that reads as broken code, an engine mismatch that only shows up
 * as a build failure ten minutes later.
 *
 * @module health/checks
 */
import * as NodePath from "node:path";

import { resolveProviderCredentialSource, type UsageProviderId } from "../usage/UsageService.ts";
import {
  AGENT_CLI_BINARIES,
  classifyAgentBinary,
  formatAgentCliDetail,
  type AgentCliObservation,
} from "./agentCliTruth.ts";
import { parseLoad1, parseNproc, verdictFromLoadAverage } from "./hostLoad.ts";
import { readHealthIncidents } from "./incidentLog.ts";
import {
  isProjectCheckoutCandidate,
  planCheckoutHeal,
  projectCheckoutFromStatusSb,
  summarizeProjectCheckouts,
  type ProjectCheckoutState,
} from "./projectCheckout.ts";
import type { HealthCheck, HealthEnv, HealthProbeResult } from "./types.ts";
import { formatWorktreeReclaimReport } from "./worktreeReclaimReport.ts";
import { isReclaimableHusk } from "./worktreeStorePaths.ts";
import { parseClaudeAuthLoggedIn } from "../provider/claudeAuth.ts";

const GIB = 1024 * 1024 * 1024;
const DISK_FAIL_BYTES = 1 * GIB;
const DISK_WARN_BYTES = 5 * GIB;
const DISK_FAIL_FRACTION = 0.03;
const DISK_WARN_FRACTION = 0.1;

const ok = (detail: string): HealthProbeResult => ({ status: "ok", detail });
const warn = (detail: string): HealthProbeResult => ({ status: "warn", detail });
const fail = (detail: string): HealthProbeResult => ({ status: "fail", detail });

function formatGib(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)}GiB`;
}

const diskHeadroom: HealthCheck = {
  id: "disk.headroom",
  title: "Free space on the state filesystem",
  severity: "critical",
  probe: async (env) => {
    const space = await env.fs.diskSpace(env.paths.stateDir);
    if (!space || space.totalBytes <= 0) {
      return warn(`could not read free space for ${env.paths.stateDir}`);
    }
    const fraction = space.freeBytes / space.totalBytes;
    const summary = `${formatGib(space.freeBytes)} free of ${formatGib(space.totalBytes)}`;
    if (space.freeBytes < DISK_FAIL_BYTES || fraction < DISK_FAIL_FRACTION) {
      return fail(`${summary} — run deploy/reclaim-disk.sh before the Btrfs store goes read-only`);
    }
    if (space.freeBytes < DISK_WARN_BYTES || fraction < DISK_WARN_FRACTION) {
      return warn(`${summary} — deploy/reclaim-disk.sh --report shows what is using it`);
    }
    return ok(summary);
  },
  autofix: {
    describe: "reclaim disk space and repair the store if it went read-only",
    run: async (env) => {
      await runRepairScript(env, "reclaim-disk.sh", [], 300_000);
    },
  },
};

const storeWritable: HealthCheck = {
  id: "store.writable",
  title: "Worktree store is writable",
  severity: "critical",
  probe: async (env) => {
    const root = env.paths.worktreeRoot;
    if (!root) return ok("no T3CODE_WORKTREE_ROOT set; sessions run in the project checkout");
    if (!(await env.fs.exists(root))) {
      return fail(`${root} does not exist — every launch will fall back to the project checkout`);
    }
    if (!(await env.fs.isWritable(root))) {
      return fail(
        `${root} is not writable — the Btrfs store is likely read-only after a full disk; ` +
          "deploy/reclaim-disk.sh remounts it",
      );
    }
    return ok(`${root} is writable`);
  },
  autofix: {
    describe: "create the worktree root",
    run: async (env) => {
      if (env.paths.worktreeRoot) await env.fs.mkdirp(env.paths.worktreeRoot);
    },
  },
};

const stateWritable: HealthCheck = {
  id: "state.writable",
  title: "State directory is writable",
  severity: "critical",
  probe: async (env) => {
    if (!(await env.fs.exists(env.paths.stateDir))) {
      return fail(`${env.paths.stateDir} does not exist`);
    }
    return (await env.fs.isWritable(env.paths.stateDir))
      ? ok(`${env.paths.stateDir} is writable`)
      : fail(`${env.paths.stateDir} is not writable — the board cannot persist anything`);
  },
  autofix: {
    describe: "create the state directory",
    run: async (env) => {
      await env.fs.mkdirp(env.paths.stateDir);
    },
  },
};

/**
 * A worktree with no `node_modules` whose checkout has one came from the
 * `git worktree add` fallback, not a Rift reflink snapshot. The agent launched
 * into it discovers this as a broken build and spends its first turns
 * reinstalling.
 *
 * Workspaces live at `<root>/<project-slug>/thread-<id>`, so the entries
 * directly under the root are project slugs, not worktrees. Reading the root as
 * if it held worktrees counted projects and resolved a main checkout for none
 * of them, which reported "N worktree(s), dependencies present" having
 * inspected nothing at all.
 */
const worktreeDeps: HealthCheck = {
  id: "worktree.deps",
  title: "Worktrees carry their dependencies",
  severity: "warn",
  probe: async (env) => {
    const root = env.paths.worktreeRoot;
    if (!root || !(await env.fs.exists(root))) return ok("no worktree store to inspect");
    const stripped: string[] = [];
    let inspected = 0;
    for (const worktree of await listWorktrees(env, root)) {
      const checkout = await resolveMainCheckout(env, worktree);
      if (!checkout) continue;
      inspected += 1;
      const checkoutHasDeps = await env.fs.exists(NodePath.join(checkout, "node_modules"));
      const worktreeHasDeps = await env.fs.exists(NodePath.join(worktree, "node_modules"));
      if (checkoutHasDeps && !worktreeHasDeps) stripped.push(NodePath.basename(worktree));
    }
    if (inspected === 0) return ok("no git-worktree fallbacks to inspect");
    if (stripped.length === 0) {
      return ok(`${inspected} git-worktree fallback(s), dependencies present`);
    }
    return warn(
      `${stripped.length} worktree(s) have no node_modules (${stripped.slice(0, 3).join(", ")}) — ` +
        "the reflink snapshot degraded to a plain git worktree; a session there will stall on install",
    );
  },
};

/**
 * Each worktree is a full dependency install (~1.7GiB for this repo), so the
 * store fills from worktree count long before anything else on the box. This
 * reports both numbers together — `disk.headroom` alone only ever said "nearly
 * full" without saying what filled it.
 */
const WORKTREE_COUNT_WARN = 6;
const WORKTREE_STORE_WARN_FRACTION = 0.15;
const WORKTREE_STORE_FULL_FRACTION = 0.05;
const WORKTREE_RECLAIM_TIMEOUT_MS = 600_000;

async function storeIsFull(env: HealthEnv, root: string): Promise<boolean> {
  const space = await env.fs.diskSpace(root);
  return (
    space !== null &&
    space.totalBytes > 0 &&
    space.freeBytes / space.totalBytes < WORKTREE_STORE_FULL_FRACTION
  );
}

/** Thread workspaces live at `<root>/<project-slug>/thread-<id>`. */
async function listWorktrees(env: HealthEnv, root: string): Promise<ReadonlyArray<string>> {
  const found: string[] = [];
  for (const project of await env.fs.readDir(root)) {
    const projectRoot = NodePath.join(root, project);
    for (const entry of await env.fs.readDir(projectRoot)) {
      if (entry.startsWith("thread-")) found.push(NodePath.join(projectRoot, entry));
    }
  }
  return found;
}

/**
 * Top-level store entries with no git and no thread-* children — git-manager
 * leftovers and empty nests that reclaim-disk never sees as worktrees.
 */
async function listReclaimableHusks(env: HealthEnv, root: string): Promise<ReadonlyArray<string>> {
  const husks: string[] = [];
  for (const name of await env.fs.readDir(root)) {
    if (name.startsWith(".")) continue;
    const absolute = NodePath.join(root, name);
    // A directory we cannot inspect is unknown, not an empty reclaimable husk.
    // Let the health runner surface the failed probe instead of authorizing a
    // destructive fix from an answer-shaped fallback.
    const children = await env.fs.readDir(absolute);
    const hasGit = await env.fs.exists(NodePath.join(absolute, ".git"));
    if (
      isReclaimableHusk({
        name,
        hasGit,
        isDirectory: true,
        childNames: children,
      })
    ) {
      husks.push(absolute);
    }
  }
  return husks;
}

/**
 * Worktrees the reclaim never removes, by basename. A `git status` that cannot
 * answer counts as dirty: the only safe reading of "unknown" here is "may hold
 * work", and it matches what the script does — it keeps anything it cannot
 * prove clean.
 */
async function dirtyWorktrees(
  env: HealthEnv,
  worktrees: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> {
  const dirty: string[] = [];
  for (const worktree of worktrees) {
    const result = await env.exec("git", ["-C", worktree, "status", "--porcelain"], {
      timeoutMs: 20_000,
    });
    if (result.code !== 0 || result.output.trim().length > 0) {
      dirty.push(NodePath.basename(worktree));
    }
  }
  return dirty;
}

const worktreeStore: HealthCheck = {
  id: "worktree.store",
  title: "Worktree store has room for another launch",
  severity: "critical",
  probe: async (env) => {
    const root = env.paths.worktreeRoot;
    if (!root || !(await env.fs.exists(root))) return ok("no worktree store to inspect");
    const worktrees = await listWorktrees(env, root);
    const count = worktrees.length;

    const space = await env.fs.diskSpace(root);
    const usage = space
      ? `${formatGib(space.freeBytes)} free of ${formatGib(space.totalBytes)}`
      : "free space unknown";
    const summary = `${count} worktree(s), ${usage}`;

    if (await storeIsFull(env, root)) {
      const dirty = await dirtyWorktrees(env, worktrees);
      if (count > 0 && dirty.length === count) {
        return fail(
          `${summary} — the store is full and every worktree has uncommitted changes ` +
            `(${dirty.slice(0, 5).join(", ")}). Fix will not remove them: commit or discard ` +
            "that work first",
        );
      }
      const reclaimable = count - dirty.length;
      return fail(
        `${summary} — the store is full; launches will fail with ENOSPC. ` +
          `Fix removes the ${reclaimable} clean, idle worktree(s)` +
          (dirty.length > 0 ? `, keeping ${dirty.length} with uncommitted changes` : ""),
      );
    }
    if (count >= WORKTREE_COUNT_WARN) {
      return warn(`${summary} — worktrees are accumulating; each one is a full dependency install`);
    }
    if (
      space &&
      space.totalBytes > 0 &&
      space.freeBytes / space.totalBytes < WORKTREE_STORE_WARN_FRACTION
    ) {
      return warn(`${summary} — running out of room for another worktree`);
    }
    return ok(summary);
  },
  /**
   * `--worktrees` is the same lever a root shell would pull, and it keeps its
   * own two guards: a worktree with any uncommitted change is never removed,
   * nor is one written to inside `T3J_WORKTREE_IDLE_MIN`. The button passes no
   * env of its own — it cannot widen what the script is willing to delete.
   *
   * Drop clean idle worktrees when the store is full *or* the count has hit
   * the warn threshold. Without the count path, warn-level accumulation never
   * self-clears: autofix only reclaimed on full, so the store sat at warn until
   * launches failed.
   */
  autofix: {
    describe:
      "reclaim the store: drop clean idle worktrees when full or count is high, and remove gitless husk dirs",
    run: async (env) => {
      const root = env.paths.worktreeRoot;
      let husksRemoved = 0;
      let husksFailed = 0;
      let worktreesBefore = 0;
      let dirtyLeft = 0;
      if (root) {
        worktreesBefore = (await listWorktrees(env, root)).length;
        dirtyLeft = (await dirtyWorktrees(env, await listWorktrees(env, root))).length;
        // Husks (no .git, no thread-*) — reclaim-disk never walks them as worktrees.
        for (const husk of await listReclaimableHusks(env, root)) {
          const result = await env.exec("rm", ["-rf", husk], { timeoutMs: 120_000 });
          if (result.code === 0) husksRemoved += 1;
          else husksFailed += 1;
        }
      }
      const dropWorktrees =
        root !== null &&
        ((await storeIsFull(env, root)) ||
          (await listWorktrees(env, root)).length >= WORKTREE_COUNT_WARN);
      // Default idle is 120m, so a Fix at warn count almost never dropped
      // anything on a busy box. Twenty minutes is long enough that a live
      // agent turn is not pulled out, and short enough that Fix does real work.
      await runRepairScript(
        env,
        "reclaim-disk.sh",
        dropWorktrees ? ["--worktrees"] : [],
        dropWorktrees ? WORKTREE_RECLAIM_TIMEOUT_MS : 300_000,
        dropWorktrees ? { T3J_WORKTREE_IDLE_MIN: "20" } : undefined,
      );
      const worktreesAfter = root ? (await listWorktrees(env, root)).length : 0;
      const dirtyAfter = root
        ? (await dirtyWorktrees(env, await listWorktrees(env, root))).length
        : dirtyLeft;
      return {
        detail: formatWorktreeReclaimReport({
          husksRemoved,
          husksFailed,
          worktreesBefore,
          worktreesAfter,
          dirtyLeft: dirtyAfter,
          ranWorktreeReclaim: dropWorktrees,
        }),
      };
    },
  },
};

/**
 * Resolve a worktree's main checkout from its `.git` file, which git writes as
 * `gitdir: <repo>/.git/worktrees/<name>`.
 */
async function resolveMainCheckout(env: HealthEnv, worktree: string): Promise<string | null> {
  const pointer = await env.fs.readFile(NodePath.join(worktree, ".git"));
  if (!pointer) return null;
  const match = /^gitdir:\s*(.+)$/m.exec(pointer.trim());
  if (!match?.[1]) return null;
  // gitdir paths use `/` even on Windows fixtures; accept either separator.
  const normalized = match[1].replace(/\\/g, "/");
  const marker = "/.git/worktrees/";
  const index = normalized.indexOf(marker);
  return index > 0 ? normalized.slice(0, index) : null;
}

/**
 * Claude Agent sessions die with "OAuth session expired" while Settings can
 * still look fine if only SDK init is probed. CLI `claude auth status` is the
 * durable truth; Fix preloads login on the host console path via reinstall
 * pattern is elsewhere — here we only diagnose and name the Log in action.
 */
const claudeAuth: HealthCheck = {
  id: "claude.auth",
  title: "Claude CLI is logged in for agent turns",
  severity: "warn",
  probe: async (env) => {
    if (!(await env.which("claude"))) {
      return ok("claude is not installed — agent.cli covers that");
    }
    const result = await env.exec("claude", ["auth", "status"], { timeoutMs: 15_000 });
    const raw = result.output.trim();
    const loggedIn = parseClaudeAuthLoggedIn(raw);
    if (loggedIn === true) return ok("claude auth status: logged in");
    if (loggedIn === false) {
      return warn(
        "Claude login expired — Settings → Models → Claude → Log in (or host terminal: claude auth login)",
      );
    }
    if (result.code !== 0) {
      return warn(
        `claude auth status exited ${result.code} — Log in from Settings → Models → Claude`,
      );
    }
    return warn("could not parse claude auth status — Log in from Settings → Models → Claude");
  },
};

const agentClis: HealthCheck = {
  id: "agent.cli",
  title: "At least one coding agent CLI is installed",
  severity: "critical",
  probe: async (env) => {
    const observations: AgentCliObservation[] = [];
    const seenPaths = new Set<string>();
    for (const binary of AGENT_CLI_BINARIES) {
      const path = await env.which(binary);
      if (!path) continue;
      // `agent` and `grok` often resolve to the same binary — report once.
      if (seenPaths.has(path) && binary === "agent") continue;
      seenPaths.add(path);
      const version = await env.exec(path, ["--version"], { timeoutMs: 8_000 });
      const versionLine =
        version.code === 0
          ? (version.output
              .split("\n")
              .find((l) => l.trim().length > 0)
              ?.trim() ?? null)
          : null;
      const versionFailed = version.code !== 0 || !versionLine;
      observations.push({
        binary,
        path,
        kind: classifyAgentBinary({ binary, versionLine }),
        versionLine,
        versionFailed,
      });
    }
    const verdict = formatAgentCliDetail(observations);
    if (verdict.status === "fail") return fail(verdict.detail);
    if (verdict.status === "warn") return warn(verdict.detail);
    return ok(verdict.detail);
  },
};

/**
 * The board owns git, so the box — not the agent — needs a forge CLI. Without
 * one a card runs to completion, the agent reports done, and the pipeline dies
 * at the last step with the worktree already reaped. That is the most expensive
 * way this box can fail, which is why it blocks the launch instead.
 */
const FORGE_CLIS = [
  { binary: "gh", label: "GitHub CLI" },
  { binary: "glab", label: "GitLab CLI" },
] as const;

async function installedForge(env: HealthEnv): Promise<(typeof FORGE_CLIS)[number] | null> {
  for (const forge of FORGE_CLIS) {
    if (await env.which(forge.binary)) return forge;
  }
  return null;
}

const forgeCli: HealthCheck = {
  id: "forge.cli",
  title: "A forge CLI can open pull requests",
  severity: "critical",
  probe: async (env) => {
    const forge = await installedForge(env);
    if (forge) return ok(`${forge.label} (${forge.binary})`);
    return fail(
      `neither ${FORGE_CLIS.map((entry) => entry.binary).join(" nor ")} is on PATH — ` +
        "every card would run to completion and then fail to open a PR; " +
        "deploy/ensure-forge.sh installs gh",
    );
  },
  autofix: {
    describe: "install the GitHub CLI",
    run: async (env) => {
      await runRepairScript(env, "ensure-forge.sh", [], 300_000);
    },
  },
};

const forgeAuth: HealthCheck = {
  id: "forge.auth",
  title: "The forge CLI is authenticated",
  severity: "critical",
  probe: async (env) => {
    const forge = await installedForge(env);
    // forge.cli already fails on a box with no CLI; do not say it twice.
    if (!forge) return ok("no forge CLI to authenticate");
    const result = await env.exec(forge.binary, ["auth", "status"], { timeoutMs: 20_000 });
    if (result.code === 0) return ok(`${forge.binary} is authenticated`);
    return fail(
      `${forge.binary} auth status exited ${result.code} — PRs cannot be opened; ` +
        `put GH_TOKEN in /etc/t3j.env and re-run Install, or \`${forge.binary} auth login\``,
    );
  },
  autofix: {
    describe: "authenticate the forge CLI from GH_TOKEN",
    run: async (env) => {
      await runRepairScript(env, "ensure-forge.sh", [], 300_000);
    },
  },
};

/**
 * `git commit` refuses without an identity, and the board commits on the card's
 * behalf — so an unconfigured box loses the work at the same late step the
 * missing forge CLI does. `git var` is the probe because it resolves exactly
 * what a commit would: env first, then config.
 */
const gitIdentity: HealthCheck = {
  id: "git.identity",
  title: "Git has an identity to commit as",
  severity: "critical",
  probe: async (env) => {
    const result = await env.exec("git", ["var", "GIT_COMMITTER_IDENT"], { timeoutMs: 10_000 });
    if (result.code === 0) {
      const ident = result.output.split(">")[0]?.concat(">").trim() ?? "";
      return ok(ident.length > 1 ? ident : "git resolves an author");
    }
    return fail(
      "git cannot resolve an author — every board commit will fail after the agent has " +
        "finished; set user.name and user.email in the global git config",
    );
  },
  autofix: {
    describe: "set a global git identity for the box",
    run: async (env) => {
      await env.exec("git", ["config", "--global", "user.name", "T3J board"], {
        timeoutMs: 10_000,
      });
      await env.exec("git", ["config", "--global", "user.email", "t3j@localhost"], {
        timeoutMs: 10_000,
      });
    },
  },
};

const nodeEngine: HealthCheck = {
  id: "node.engine",
  title: "Node matches the engine the release asks for",
  severity: "warn",
  probe: async (env) => {
    const root = env.paths.releaseRoot;
    if (!root) return ok("no release root to compare against");
    const raw = await env.fs.readFile(NodePath.join(root, "package.json"));
    if (!raw) return ok("release package.json is not readable");
    const wanted = readEnginesNode(raw);
    if (!wanted) return ok(`node ${env.nodeVersion}, no engine pinned`);
    const wantedMajor = /(\d+)/.exec(wanted)?.[1];
    const runningMajor = /(\d+)/.exec(env.nodeVersion)?.[1];
    if (!wantedMajor || !runningMajor || wantedMajor === runningMajor) {
      return ok(`node ${env.nodeVersion} satisfies ${wanted}`);
    }
    return warn(
      `node ${env.nodeVersion} but the release wants ${wanted} — installs and builds can fail ` +
        "in ways that read as broken code",
    );
  },
};

function readEnginesNode(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { engines?: { node?: unknown } };
    const node = parsed.engines?.node;
    return typeof node === "string" && node.length > 0 ? node : null;
  } catch {
    return null;
  }
}

const EGRESS_TARGETS = [
  { label: "registry.npmjs.org", url: "https://registry.npmjs.org/-/ping" },
  { label: "github.com", url: "https://github.com" },
] as const;

/**
 * A blocked host is a wall, not a bug. Naming it here is what stops the next
 * session from rewriting build config to work around an unreachable registry.
 */
const netEgress: HealthCheck = {
  id: "net.egress",
  title: "The hosts a session needs are reachable",
  severity: "warn",
  probe: async (env) => {
    const blocked: string[] = [];
    for (const target of EGRESS_TARGETS) {
      if (!(await env.reachable(target.url, 5_000))) blocked.push(target.label);
    }
    if (blocked.length === 0) return ok(EGRESS_TARGETS.map((t) => t.label).join(", "));
    return warn(
      `unreachable: ${blocked.join(", ")} — treat install and push failures as a network wall, ` +
        "not as broken code",
    );
  },
};

/** A repo script, or `null` when this box has no deploy checkout to run from. */
function scriptPath(env: HealthEnv, name: string): string | null {
  return env.paths.repoRoot ? NodePath.join(env.paths.repoRoot, "deploy", name) : null;
}

const BOX_TOOL_LIB = "/usr/local/lib/t3j";

/**
 * The scripts `deploy/install-box-tools.sh` copies onto the box. Keep in step
 * with its loop — a name listed here that it does not install resolves to
 * nothing and falls through to the deploy checkout.
 */
const BOX_TOOL_SCRIPTS = new Set(["reclaim-disk.sh", "ensure-rift-storage.sh"]);

/**
 * Where a repair script can actually be run from, most current first.
 *
 * `install-box-tools.sh` re-installs its scripts out of the commit being
 * deployed on every apply, so `/usr/local/lib/t3j` always matches the running
 * release. `T3CODE_VPS_REPO_PATH` (`/opt/vps-code`) is only ever fetched, never
 * checked out — its working tree can predate the flags this code passes, which
 * would make a button run an older script that quietly ignores them. Same file
 * either way; the box copy is the one that is current.
 */
function repairScriptCandidates(env: HealthEnv, name: string): ReadonlyArray<string> {
  const boxCopy = BOX_TOOL_SCRIPTS.has(name)
    ? [NodePath.join(env.envVar("T3J_TOOL_LIB") ?? BOX_TOOL_LIB, name)]
    : [];
  const checkout = scriptPath(env, name);
  return checkout ? [...boxCopy, checkout] : boxCopy;
}

/**
 * Run a repair script, or throw with the reason it could not run. An autofix
 * that silently skips a missing script leaves the user staring at "still
 * failing" with a Fix button that appears to do nothing.
 */
async function runRepairScript(
  env: HealthEnv,
  name: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
  extraEnv?: Readonly<Record<string, string>>,
): Promise<void> {
  const candidates = repairScriptCandidates(env, name);
  let script: string | null = null;
  for (const candidate of candidates) {
    if (await env.fs.exists(candidate)) {
      script = candidate;
      break;
    }
  }
  if (!script) {
    const where =
      candidates.length > 0
        ? `not found at ${candidates.join(" or ")}`
        : "no deploy checkout on this box (T3CODE_VPS_REPO_PATH unset)";
    throw new Error(`cannot run deploy/${name}: ${where}`);
  }
  // `env VAR=value bash script` so reclaim can tighten idle without changing
  // the global default for the timer path.
  const envPairs = Object.entries(extraEnv ?? {}).map(([key, value]) => `${key}=${value}`);
  const result =
    envPairs.length > 0
      ? await env.exec("env", [...envPairs, "bash", script, ...args], { timeoutMs })
      : await env.exec("bash", [script, ...args], { timeoutMs });
  if (result.code !== 0) {
    const tail = result.output.split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 300);
    throw new Error(`deploy/${name} exited ${result.code}${tail ? `: ${tail}` : ""}`);
  }
}

/**
 * `codex app-server` swallows every reason it could not open its sqlite state
 * behind one message, so the doctor script is the only thing that can say
 * which one it is — and until now you had to be at a root shell to run it.
 */
const codexHome: HealthCheck = {
  id: "codex.home",
  title: "Codex can open its state",
  severity: "warn",
  probe: async (env) => {
    if (!(await env.which("codex"))) return ok("codex is not installed on this box");
    const script = scriptPath(env, "codex-home-doctor.sh");
    if (!script || !(await env.fs.exists(script))) return ok("no deploy checkout to diagnose from");
    const result = await env.exec("bash", [script, "--check"], { timeoutMs: 60_000 });
    return result.code === 0
      ? ok("CODEX_HOME is healthy")
      : warn(`${result.output.split("\n").slice(-3).join(" ").slice(0, 300)} — fixable here`);
  },
  autofix: {
    describe: "repair CODEX_HOME",
    run: async (env) => {
      await runRepairScript(env, "codex-home-doctor.sh", [], 120_000);
    },
  },
};

/**
 * The board brain needs at least one tier that can plausibly serve. This is the
 * env-level view (binaries and keys); Settings → Hermes → Recheck holds the
 * authoritative per-tier probe, including live OpenRouter key validation.
 */
/**
 * Resolve a family's key through the shared credential table, but over the
 * probe's own fs and env seams so a health run stays injectable.
 */
async function healthProviderCredential(
  env: HealthEnv,
  family: UsageProviderId,
): Promise<string | null> {
  return resolveProviderCredentialSource(family, {
    homeDir: env.envVar("HOME") ?? "/root",
    env: new Proxy(
      {},
      {
        get: (_target, name) =>
          typeof name === "string" ? (env.envVar(name) ?? undefined) : undefined,
      },
    ) as Record<string, string | undefined>,
    readFile: async (path) => {
      const raw = await env.fs.readFile(path);
      if (raw === null) throw new Error(`unreadable: ${path}`);
      return raw;
    },
  });
}

const hermesTiers: HealthCheck = {
  id: "hermes.tiers",
  title: "Hermes has a backend tier to serve from",
  severity: "warn",
  probe: async (env) => {
    const tiers: string[] = [];
    if (await env.which("cursor-agent")) tiers.push("cursor");
    if (await env.which("grok")) {
      tiers.push(env.envVar("XAI_API_KEY") ? "xai (key set)" : "xai (cached login only)");
    }
    const openRouterSource = await healthProviderCredential(env, "openrouter");
    if (openRouterSource) tiers.push(`openrouter (${openRouterSource})`);
    if (tiers.length === 0) {
      return warn(
        "no cursor-agent or grok binary and no OpenRouter key — the board brain cannot run; " +
          "paste one in Settings → Connections → API keys or run deploy/ensure-agent-clis.sh",
      );
    }
    return ok(tiers.join(", "));
  },
};

const canvasImages: HealthCheck = {
  id: "canvas.images",
  title: "Canvas image generation is configured",
  severity: "warn",
  probe: async (env) => {
    const key = env.envVar("OPENAI_API_KEY")?.trim() || env.envVar("T3CODE_OPENAI_API_KEY")?.trim();
    return key
      ? ok("OpenAI Images API key is set (OPENAI_API_KEY or T3CODE_OPENAI_API_KEY)")
      : warn(
          "image generation unavailable — add OPENAI_API_KEY under Settings → Connections / API keys " +
            "or /etc/t3j.env; Codex ChatGPT login alone does not serve canvas images; " +
            "xAI and OpenRouter keys do not either",
        );
  },
};

/**
 * Host thrash: load >> nproc makes every agent CLI time out, so self-heal dies.
 */
const hostLoad: HealthCheck = {
  id: "host.load",
  title: "Load average is within the box's cores",
  severity: "warn",
  probe: async (env) => {
    const loadRaw = await env.fs.readFile("/proc/loadavg");
    const load1 =
      loadRaw !== null
        ? parseLoad1(loadRaw)
        : parseLoad1((await env.exec("uptime", [], { timeoutMs: 5_000 })).output);
    const nprocRaw = await env.exec("nproc", [], { timeoutMs: 5_000 });
    const nproc = parseNproc(nprocRaw.output) ?? 1;
    if (load1 === null) return warn("could not read load average");
    const verdict = verdictFromLoadAverage({ load1, nproc });
    if (verdict.status === "fail") return fail(verdict.detail);
    if (verdict.status === "warn") return warn(verdict.detail);
    return ok(verdict.detail);
  },
};

/**
 * Project checkouts used as forge cwd must be on a branch. Detached HEAD is the
 * #1 ship-breaker for openPr/merge.
 */
async function listProjectCheckouts(env: HealthEnv): Promise<ReadonlyArray<ProjectCheckoutState>> {
  const worktreeRoot = env.paths.worktreeRoot;
  const projectsRoot =
    env.envVar("T3CODE_PROJECTS_ROOT") ?? (worktreeRoot ? NodePath.dirname(worktreeRoot) : null);
  if (!projectsRoot || !(await env.fs.exists(projectsRoot))) return [];
  const states: ProjectCheckoutState[] = [];
  for (const name of await env.fs.readDir(projectsRoot)) {
    if (!isProjectCheckoutCandidate(name)) continue;
    const path = NodePath.join(projectsRoot, name);
    if (!(await env.fs.exists(NodePath.join(path, ".git")))) continue;
    const result = await env.exec("git", ["-C", path, "status", "-sb"], { timeoutMs: 15_000 });
    states.push(
      projectCheckoutFromStatusSb({
        path,
        name,
        statusSb: result.code === 0 ? result.output : null,
        exitCode: result.code,
      }),
    );
  }
  return states;
}

const projectCheckout: HealthCheck = {
  id: "project.checkout",
  title: "Project checkouts are on a branch for forge ops",
  severity: "critical",
  probe: async (env) => {
    const states = await listProjectCheckouts(env);
    const summary = summarizeProjectCheckouts(states);
    if (summary.status === "fail") return fail(summary.detail);
    if (summary.status === "warn") return warn(summary.detail);
    return ok(summary.detail);
  },
  autofix: {
    describe: "checkout the default branch on clean detached project roots",
    run: async (env) => {
      const states = await listProjectCheckouts(env);
      const healed: string[] = [];
      const skipped: string[] = [];
      for (const state of states) {
        const plan = planCheckoutHeal(state, "main");
        if (plan.action === "skip") {
          if (state.detached) skipped.push(`${state.name} (${plan.reason})`);
          continue;
        }
        const co = await env.exec("git", ["-C", state.path, "checkout", plan.branch], {
          timeoutMs: 30_000,
        });
        if (co.code === 0) healed.push(`${state.name}→${plan.branch}`);
        else skipped.push(`${state.name} (checkout failed)`);
      }
      const parts: string[] = [];
      if (healed.length > 0) parts.push(`healed ${healed.join(", ")}`);
      if (skipped.length > 0) parts.push(`skipped ${skipped.join(", ")}`);
      if (parts.length === 0) parts.push("nothing to heal");
      return { detail: parts.join("; ") };
    },
  },
};

const RUNTIME_INCIDENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const RUNTIME_INCIDENT_SCAN = 500;

/**
 * Failures the running server recorded for itself — a degraded fallback that
 * fired, a turn that wedged — none of which any probe above can see after the
 * fact.
 *
 * Without this they are written and never read: the incident log only reaches
 * the Settings panel through a check with the same id, so an incident no check
 * owns is invisible. That is the reflink failure mode in miniature — the box
 * knew, and told nobody.
 */
const runtimeIncidents: HealthCheck = {
  id: "runtime.incidents",
  title: "Nothing degraded or wedged since yesterday",
  severity: "warn",
  probe: async (env) => {
    const owned = new Set(HEALTH_CHECKS.map((check) => check.id));
    const floor = env.nowMs() - RUNTIME_INCIDENT_WINDOW_MS;
    const recent = readHealthIncidents(RUNTIME_INCIDENT_SCAN).filter((incident) => {
      if (owned.has(incident.id)) return false;
      const at = Date.parse(incident.at);
      return Number.isFinite(at) && at >= floor;
    });
    if (recent.length === 0) return ok("no runtime incident in the last 24h");
    const counts = new Map<string, number>();
    for (const incident of recent) counts.set(incident.id, (counts.get(incident.id) ?? 0) + 1);
    const summary = [...counts.entries()]
      .toSorted((left, right) => right[1] - left[1])
      .map(([id, count]) => `${id} ×${count}`)
      .join(", ");
    const latest = recent[recent.length - 1];
    return warn(`${summary} — latest: ${latest?.detail ?? "no detail"}`);
  },
};

export const HEALTH_CHECKS: ReadonlyArray<HealthCheck> = [
  diskHeadroom,
  storeWritable,
  stateWritable,
  worktreeStore,
  worktreeDeps,
  hostLoad,
  projectCheckout,
  agentClis,
  claudeAuth,
  forgeCli,
  forgeAuth,
  gitIdentity,
  nodeEngine,
  netEgress,
  codexHome,
  hermesTiers,
  canvasImages,
  runtimeIncidents,
];
