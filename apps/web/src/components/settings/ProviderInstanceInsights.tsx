import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type { BoardSettings } from "@t3tools/contracts";

import { readBoardSettings, subscribeBoardSettings } from "../../lib/boardSettings";
import {
  formatPercent,
  formatResourceValue,
  primaryResource,
  providerForSelection,
  providerUsageUnusableReason,
  usageColor,
  usageProviderIdForSelection,
  utilization,
  type UsageEntry,
} from "../../lib/providerUsage";
import { useUsageSnapshot } from "../../hooks/useUsageSnapshot";
import { cn } from "../../lib/utils";
import { usageCredentialStatus, useUsageCredentials } from "./usageCredentials";

export type ProviderUsedByChip = {
  readonly label: string;
  readonly station: string;
};

/** Where this instance is wired across the app, from live board settings. */
function boardUsedByChips(board: BoardSettings, instanceId: string): ProviderUsedByChip[] {
  const chips: ProviderUsedByChip[] = [];
  if (board.hermesBrainInstanceId === instanceId) {
    chips.push({ label: "Hermes brain", station: "settings:hermes" });
  }
  const rosterRules = board.modelRoster.filter((entry) => entry.instanceId === instanceId).length;
  if (rosterRules > 0) {
    chips.push({
      label: `Auto Router · ${rosterRules} rule${rosterRules === 1 ? "" : "s"}`,
      station: "settings:models",
    });
  }
  if (board.composerInstanceId === instanceId) {
    chips.push({ label: "Composer preset", station: "settings:board" });
  }
  if (board.hermesInstanceId === instanceId) {
    chips.push({ label: "Hermes skills", station: "settings:board" });
  }
  return chips;
}

function UsedByChipLink({ chip }: { readonly chip: ProviderUsedByChip }) {
  return (
    <Link
      to="/kanban"
      search={{ station: chip.station }}
      className="inline-flex items-center rounded-full bg-raised px-2 py-0.5 text-[11px] text-foreground/90 transition-colors hover:border-border hover:bg-muted/70"
    >
      {chip.label}
    </Link>
  );
}

/**
 * Which source feeds this family's usage numbers. Read-only — keys are entered
 * once in the API keys section, which links from here.
 */
function UsageCredentialRow({ family }: { readonly family: string }) {
  const { statuses, error } = useUsageCredentials();
  const status = usageCredentialStatus(statuses, family);

  if (statuses === null && error === null) return null;

  return (
    <p className="mt-2 text-xs text-muted-foreground">
      <span className="font-medium text-foreground/80">Usage credential:</span>{" "}
      {error ? (
        <span className="text-warning">status unavailable — {error}</span>
      ) : status?.source ? (
        <code className="rounded bg-muted/60 px-1 py-0.5 text-[11px]">{status.source}</code>
      ) : status?.writable ? (
        <>
          <span className="text-warning">not found</span> —{" "}
          <Link
            to="/kanban"
            search={{ station: "settings:connections" }}
            className="text-primary hover:underline"
          >
            add a key in API keys
          </Link>
        </>
      ) : status ? (
        <span className="text-warning">not found — usage cannot be read for this provider</span>
      ) : (
        <span>not tracked for this provider</span>
      )}
    </p>
  );
}

/**
 * Usage + wiring summary inside an expanded provider card, so the whole
 * provider lifecycle reads from one place instead of the kanban header ring
 * and four other settings pages.
 */
export function ProviderInstanceInsights(props: {
  readonly instanceId: string;
  readonly modelCount: number;
  readonly hiddenModelCount: number;
  readonly customModelCount: number;
  readonly favoriteCount: number;
  /** Enabled instances (including this one) whose usage collapses to the same family. */
  readonly usageSharedInstanceCount: number;
  /** Chips owned by unified app settings (routing fallback, git text), computed by the caller. */
  readonly appUsedBy: ReadonlyArray<ProviderUsedByChip>;
}) {
  const [board, setBoard] = useState<BoardSettings>(() => readBoardSettings());
  useEffect(() => subscribeBoardSettings(setBoard), []);
  const usage = useUsageSnapshot();

  const usageEntries = useMemo<ReadonlyArray<UsageEntry>>(
    () =>
      Object.entries(usage.data?.providers ?? {}).map(([id, provider]) => ({ id, ...provider })),
    [usage.data],
  );
  const usageEntry = providerForSelection(usageEntries, props.instanceId);
  const unusableReason = providerUsageUnusableReason(usage.data, props.instanceId);
  const family = usageProviderIdForSelection(props.instanceId);
  const usageError = (usage.data?.errors ?? []).find((error) => error.providerId === family);
  const resource = primaryResource(usageEntry);
  const primaryUtil = utilization(resource);

  const chips = [...boardUsedByChips(board, props.instanceId), ...props.appUsedBy];

  const modelSummary = [
    `${props.modelCount} model${props.modelCount === 1 ? "" : "s"}`,
    props.customModelCount > 0 ? `${props.customModelCount} custom` : null,
    props.hiddenModelCount > 0 ? `${props.hiddenModelCount} hidden` : null,
    props.favoriteCount > 0 ? `${props.favoriteCount} favorited` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <div className="border-t border-border/60 px-4 py-3 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-foreground">Models</span>
          <Link
            to="/kanban"
            search={{ station: "settings:models" }}
            className="text-xs text-primary hover:underline"
          >
            Manage in Models
          </Link>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{modelSummary}</p>
      </div>

      <div className="border-t border-border/60 px-4 py-3 sm:px-5">
        <span className="text-xs font-medium text-foreground">Usage</span>
        {usage.data === null ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {usage.error ? `Usage unavailable — ${usage.error}` : "Loading usage…"}
          </p>
        ) : unusableReason ? (
          <p className="mt-1 text-xs text-warning">{unusableReason}</p>
        ) : usageEntry ? (
          <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            <p className="flex flex-wrap items-center gap-x-2">
              {usageEntry.plan ? <span>{usageEntry.plan}</span> : null}
              {resource ? (
                <span className="font-medium tabular-nums text-foreground">
                  {formatResourceValue(resource)}
                </span>
              ) : (
                <span>No usage numbers reported.</span>
              )}
              {primaryUtil !== null ? (
                <span
                  className="font-medium tabular-nums"
                  style={{ color: usageColor(primaryUtil) }}
                >
                  {formatPercent(primaryUtil * 100)}%
                </span>
              ) : null}
              {usageEntry.stale ? <span>(stale)</span> : null}
            </p>
            {props.usageSharedInstanceCount > 1 ? (
              <p>Shared across {props.usageSharedInstanceCount} instances of this provider.</p>
            ) : null}
          </div>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            {usageError?.message?.trim() || "No usage data for this provider."}
          </p>
        )}
        <UsageCredentialRow family={family} />
      </div>

      <div className="border-t border-border/60 px-4 py-3 sm:px-5">
        <span className="text-xs font-medium text-foreground">Used by</span>
        {chips.length > 0 ? (
          <div className={cn("mt-1.5 flex flex-wrap gap-1.5")}>
            {chips.map((chip) => (
              <UsedByChipLink key={`${chip.label}:${chip.station}`} chip={chip} />
            ))}
          </div>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            Nothing routes to this instance — pick it in Auto Router, Hermes, or the composer to use
            it.
          </p>
        )}
      </div>
    </>
  );
}
