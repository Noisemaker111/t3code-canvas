/**
 * Which branch a card's worktree is cut from.
 *
 * Empty means "inherit" — the project's default base branch, then the repo's
 * own default. Only remote-tracking branches are offered: a local-only branch
 * is not something the box can start fresh work from.
 */
import { useMemo } from "react";

import { useBranches } from "../../state/queries";
import type { EnvironmentId } from "@t3tools/contracts";

export function BaseBranchPicker({
  environmentId,
  cwd,
  value,
  inheritedLabel,
  disabled,
  onChange,
  className,
}: {
  environmentId: EnvironmentId | null;
  /** The project checkout to read branches from; null disables the picker. */
  cwd: string | null;
  value: string;
  /** What an empty selection resolves to, shown on the inherit option. */
  inheritedLabel: string;
  disabled: boolean;
  onChange: (next: string) => void;
  className?: string;
}) {
  const refs = useBranches({ environmentId, cwd, query: "" });

  const names = useMemo(() => {
    // Remote and local refs both name a branch the box can start from — the
    // server resolves the choice as `origin/<name>` either way — so the remote
    // prefix is stripped and the two lists collapse into one.
    const listed = (refs.data?.refs ?? []).map((ref) =>
      ref.remoteName && ref.name.startsWith(`${ref.remoteName}/`)
        ? ref.name.slice(ref.remoteName.length + 1)
        : ref.name,
    );
    // The saved value may not be in the page we fetched; never drop it.
    const all = value.trim().length > 0 ? [value.trim(), ...listed] : listed;
    return [...new Set(all)]
      .filter((name) => name !== "HEAD")
      .sort((left, right) => left.localeCompare(right));
  }, [refs.data, value]);

  return (
    <select
      className={className}
      value={value}
      disabled={disabled || cwd === null}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Default ({inheritedLabel})</option>
      {names.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </select>
  );
}
