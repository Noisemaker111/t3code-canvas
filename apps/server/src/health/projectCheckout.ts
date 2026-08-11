/**
 * Pure classification of project git checkouts for health probes and heals.
 * Detached HEAD and dirtiness poison forge ops (`gh pr merge` needs a branch).
 *
 * @module health/projectCheckout
 */

export type ProjectCheckoutState = {
  readonly path: string;
  readonly name: string;
  /** Branch name when attached; null when detached or unreadable. */
  readonly branch: string | null;
  readonly detached: boolean;
  readonly dirty: boolean;
  /** True when `git status -sb` could not be read. */
  readonly unreadable: boolean;
};

/**
 * Parse the first line of `git status -sb` (short + branch).
 * Examples:
 *   `## main...origin/main`
 *   `## HEAD (no branch)`
 *   `## feature/foo`
 */
export function parseGitShortBranchLine(line: string): {
  readonly branch: string | null;
  readonly detached: boolean;
} {
  const trimmed = line.trim();
  if (!trimmed.startsWith("##")) {
    return { branch: null, detached: false };
  }
  const rest = trimmed.slice(2).trim();
  if (rest === "HEAD (no branch)" || rest.startsWith("HEAD (no branch)")) {
    return { branch: null, detached: true };
  }
  // `## main...origin/main [behind 2]` or `## main`
  const name = rest.split("...")[0]?.split(/\s+/)[0]?.trim() ?? "";
  if (!name || name === "HEAD") {
    return { branch: null, detached: name === "HEAD" };
  }
  return { branch: name, detached: false };
}

/** True when porcelain status (excluding the `##` branch line) has entries. */
export function isDirtyFromStatusSb(output: string): boolean {
  for (const line of output.split("\n")) {
    const t = line.trimEnd();
    if (!t) continue;
    if (t.startsWith("##")) continue;
    return true;
  }
  return false;
}

export function projectCheckoutFromStatusSb(input: {
  readonly path: string;
  readonly name: string;
  readonly statusSb: string | null;
  readonly exitCode: number;
}): ProjectCheckoutState {
  if (input.statusSb === null || input.exitCode !== 0) {
    return {
      path: input.path,
      name: input.name,
      branch: null,
      detached: false,
      dirty: true,
      unreadable: true,
    };
  }
  const first = input.statusSb.split("\n").find((l) => l.trim().length > 0) ?? "";
  const { branch, detached } = parseGitShortBranchLine(first);
  return {
    path: input.path,
    name: input.name,
    branch,
    detached,
    dirty: isDirtyFromStatusSb(input.statusSb),
    unreadable: false,
  };
}

/**
 * Summarize many project checkouts into one probe line.
 * Detached is fail-worthy for forge; dirty alone is warn.
 */
export function summarizeProjectCheckouts(states: ReadonlyArray<ProjectCheckoutState>): {
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
} {
  if (states.length === 0) {
    return { status: "ok", detail: "no project checkouts to inspect" };
  }
  const detached = states.filter((s) => s.detached);
  const dirty = states.filter((s) => s.dirty && !s.unreadable);
  const unreadable = states.filter((s) => s.unreadable);
  const onBranch = states.filter((s) => s.branch && !s.detached);

  if (detached.length > 0) {
    const names = detached
      .map((s) => s.name)
      .slice(0, 5)
      .join(", ");
    return {
      status: "fail",
      detail:
        `${detached.length} project checkout(s) on detached HEAD (${names}) — ` +
        "gh/forge ops fail with not on any branch; Fix checks out the default branch when clean",
    };
  }
  if (unreadable.length > 0) {
    const names = unreadable
      .map((s) => s.name)
      .slice(0, 5)
      .join(", ");
    return {
      status: "warn",
      detail: `${unreadable.length} project checkout(s) unreadable (${names})`,
    };
  }
  if (dirty.length > 0) {
    const names = dirty
      .map((s) => s.name)
      .slice(0, 5)
      .join(", ");
    return {
      status: "warn",
      detail:
        `${onBranch.length} on a branch; ${dirty.length} dirty (${names}) — ` +
        "heal skips dirty trees so local edits are not discarded",
    };
  }
  const sample = onBranch
    .map((s) => `${s.name}@${s.branch}`)
    .slice(0, 4)
    .join(", ");
  return {
    status: "ok",
    detail: `${states.length} project checkout(s) on a branch (${sample || "ok"})`,
  };
}

/**
 * Safe heal: only when detached and clean — checkout defaultBranch (main).
 * Dirty detached trees are left alone (report only).
 */
export function planCheckoutHeal(
  state: ProjectCheckoutState,
  defaultBranch = "main",
):
  | { readonly action: "checkout"; readonly branch: string }
  | { readonly action: "skip"; readonly reason: string } {
  if (state.unreadable) return { action: "skip", reason: "unreadable" };
  if (!state.detached) return { action: "skip", reason: "already on a branch" };
  if (state.dirty) return { action: "skip", reason: "detached and dirty — refuse to discard work" };
  return { action: "checkout", branch: defaultBranch };
}

/**
 * Top-level dirs under a projects root that look like git checkouts.
 * Skips `.worktrees` and other dot entries.
 */
export function isProjectCheckoutCandidate(name: string): boolean {
  if (!name || name.startsWith(".")) return false;
  if (name === "worktrees" || name === ".worktrees") return false;
  return true;
}
