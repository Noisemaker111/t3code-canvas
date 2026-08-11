import { memo } from "react";

import { resolveLockedWorkspaceLabel, type EnvMode } from "./BranchToolbar.logic";
import { Checkbox } from "./ui/checkbox";

interface BranchToolbarEnvModeSelectorProps {
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
}: BranchToolbarEnvModeSelectorProps) {
  if (envLocked) {
    return (
      <span className="inline-flex items-center gap-1.5 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs">
        <Checkbox checked={effectiveEnvMode === "worktree"} disabled aria-label="Worktree" />
        <span className="truncate">Worktree</span>
      </span>
    );
  }

  return (
    <label
      className="inline-flex cursor-pointer items-center gap-1.5 px-2 text-sm font-medium text-muted-foreground/80 sm:text-xs"
      title={
        activeWorktreePath
          ? resolveLockedWorkspaceLabel(activeWorktreePath)
          : "Use an isolated worktree for this thread"
      }
    >
      <Checkbox
        checked={effectiveEnvMode === "worktree"}
        aria-label="Use worktree"
        onCheckedChange={(checked) => onEnvModeChange(checked ? "worktree" : "local")}
      />
      <span>Worktree</span>
    </label>
  );
});
