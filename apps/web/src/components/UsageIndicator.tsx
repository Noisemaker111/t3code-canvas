import { useEffect, useMemo, useState } from "react";
import { RefreshCwIcon, TrendingUpIcon } from "lucide-react";

import type { ScopedThreadRef } from "@t3tools/contracts";
import { useComposerDraftStore } from "../composerDraftStore";
import { cn } from "~/lib/utils";
import {
  type UsageEntry,
  type UsageHistoryStore,
  type UsageResource,
  burnRatePerHour,
  formatHours,
  formatPercent,
  formatProviderName,
  formatResourceLabel,
  formatResourceValue,
  isListPriceUsd,
  hoursUntilExhausted,
  hoursUntilReset,
  primaryResource,
  providerForSelection,
  providerUsageUnusableReason,
  readUsageHistory,
  recordUsageSnapshot,
  sortUsageResources,
  usageColor,
  utilization,
  type UsageResponse,
} from "~/lib/providerUsage";
import { useUsageSnapshot } from "../hooks/useUsageSnapshot";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";

/** OpenUsage-style burn-rate line: rate of consumption plus, when it would outrun the reset
 * window, a "before reset" warning. Null when there isn't enough history yet or the resource
 * has no visible trend. */
function formatBurnRate(
  history: UsageHistoryStore,
  providerId: string,
  resourceId: string,
  resource: UsageResource,
  nowMs: number,
): string | null {
  if (isListPriceUsd(resource)) return null;
  const rate = burnRatePerHour(history, providerId, resourceId, resource.kind);
  if (rate === null) return null;
  const unit = resource.unit === "percent" ? "%" : ` ${resource.unit ?? ""}`.trimEnd();
  const exhaustedIn = hoursUntilExhausted(resource, rate);
  const resetsIn = hoursUntilReset(resource.resetsAt, nowMs);
  const base = `≈${rate < 10 ? rate.toFixed(1) : Math.round(rate)}${unit}/hr`;
  if (exhaustedIn !== null && (resetsIn === null || exhaustedIn < resetsIn)) {
    return `${base} · exhausted in ~${formatHours(exhaustedIn)}`;
  }
  return base;
}

function formatUpdatedAt(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return ` · updated ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function formatReset(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `Resets ${date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function UsageRing({ resource }: { resource: UsageResource | null }) {
  const value = utilization(resource);
  const percent = value === null ? 0 : Math.round(value * 100);
  const color = usageColor(value);
  return (
    <div
      aria-label={
        value === null ? "Usage unavailable" : percent === 0 ? "No usage yet" : `${percent}% usage`
      }
      className="relative size-7 shrink-0 rounded-full"
      role="img"
      style={{
        background:
          value === null
            ? "conic-gradient(#3f3f46 0 100%)"
            : `conic-gradient(${color} 0 ${percent}%, transparent ${percent}% 100%)`,
      }}
    >
      {/* "0%" is unreadable — a fresh window and a broken read look the same.
          A word says the read worked and nothing is used. */}
      <div className="absolute inset-[3px] flex items-center justify-center rounded-full bg-card text-[9px] font-semibold tabular-nums text-foreground">
        {value === null ? "—" : percent === 0 ? "none" : `${percent}%`}
      </div>
    </div>
  );
}

function UsageProviderRow({
  provider,
  history,
  nowMs,
  usage,
}: {
  provider: UsageEntry;
  history: UsageHistoryStore;
  nowMs: number;
  usage: UsageResponse | null;
}) {
  const resources = sortUsageResources(Object.entries(provider.resources ?? {}));
  const providerName = formatProviderName(provider.id, provider.displayName);
  const plan = provider.plan?.trim();
  const unusableReason = providerUsageUnusableReason(usage, provider.id);
  const primary = primaryResource(provider);
  const primaryUtil = utilization(primary);
  return (
    <section
      className={cn(
        "rounded-lg border border-border/70 bg-card px-2.5 py-2 shadow-sm",
        unusableReason && "border-destructive/35 bg-destructive/5",
      )}
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <h3 className="truncate text-xs font-medium">{providerName}</h3>
            {provider.stale ? (
              <span
                className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground"
                title="This provider could not be refreshed; showing its last known values."
              >
                Stale
              </span>
            ) : null}
          </div>
          {plan ? <p className="truncate text-[10px] text-muted-foreground">{plan}</p> : null}
        </div>
        {primaryUtil !== null && primary?.kind !== "balance" ? (
          primaryUtil === 0 ? (
            <p className="shrink-0 text-[10px] font-medium text-muted-foreground">No usage yet</p>
          ) : (
            <p
              className="shrink-0 text-xs font-semibold tabular-nums"
              style={{ color: usageColor(primaryUtil) }}
            >
              {formatPercent(primaryUtil * 100)}%
            </p>
          )
        ) : null}
      </div>
      <div className="space-y-1.5">
        {resources.map(([id, resource]) => {
          const value = utilization(resource);
          const burnRate = formatBurnRate(history, provider.id, id, resource, nowMs);
          const showBar =
            value !== null && resource.kind !== "balance" && !isListPriceUsd(resource);
          return (
            <div key={id} className="min-w-0">
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="text-muted-foreground">{formatResourceLabel(id)}</span>
                <span className="font-medium tabular-nums">{formatResourceValue(resource)}</span>
              </div>
              {showBar ? (
                <div
                  aria-label={`${formatResourceLabel(id)} usage`}
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={Math.round(value * 100)}
                  className="mt-1 h-1 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                >
                  <div
                    className="h-full rounded-full transition-[width]"
                    style={{
                      backgroundColor: usageColor(value),
                      width: `${Math.round(value * 100)}%`,
                    }}
                  />
                </div>
              ) : null}
              {formatReset(resource.resetsAt) || burnRate ? (
                <p className="mt-0.5 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                  <span>{formatReset(resource.resetsAt)}</span>
                  {burnRate ? (
                    <span className="flex items-center gap-1 tabular-nums">
                      <TrendingUpIcon className="size-2.5" />
                      {burnRate}
                    </span>
                  ) : null}
                </p>
              ) : null}
            </div>
          );
        })}
        {unusableReason ? (
          <p className="truncate whitespace-nowrap text-[10px] font-medium text-destructive">
            {unusableReason}
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function UsageIndicator({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  const selectedProviderId = useComposerDraftStore(
    (state) =>
      (threadRef ? state.getComposerDraft(threadRef)?.activeProvider : null) ??
      state.stickyActiveProvider,
  );
  const [open, setOpen] = useState(false);
  const { data, error: fetchError, isRefreshing, lastSuccessAt, refresh } = useUsageSnapshot();
  const [history, setHistory] = useState<UsageHistoryStore>(() => readUsageHistory(null));

  useEffect(() => {
    setHistory(readUsageHistory(window.localStorage));
  }, []);

  const providers = useMemo<ReadonlyArray<UsageEntry>>(
    () =>
      Object.entries(data?.providers ?? {}).map(([id, provider]) => ({
        id,
        ...provider,
      })),
    [data],
  );

  // Every successful fetch appends a burn-rate snapshot; recorded from `data` (not `fetchState`)
  // so a failed cycle that leaves last-known-good data in place doesn't append a duplicate point.
  useEffect(() => {
    if (!data || providers.length === 0) return;
    setHistory(recordUsageSnapshot(window.localStorage, providers, Date.now()));
  }, [data]);

  const selectedProvider = providerForSelection(providers, selectedProviderId);
  const selectedResource = primaryResource(selectedProvider);
  const selectedName = formatProviderName(
    selectedProvider?.id ?? selectedProviderId,
    selectedProvider?.displayName,
  );
  const hasListPrice = providers.some(
    (provider) => provider.resources?.listToday != null || provider.resources?.listWeek != null,
  );
  const hasStaleProvider = providers.some((provider) => provider.stale === true);
  const nowMs = Date.now();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            aria-label={`Open usage for ${selectedName}`}
            className="size-8 shrink-0 rounded-full p-0"
            title={`Usage: ${selectedName}`}
            variant="ghost"
          />
        }
      >
        <UsageRing resource={selectedResource} />
      </PopoverTrigger>
      {/*
        Scroll must live on PopoverViewport (overflow-y-auto). Do NOT put overflow-hidden
        on the viewport + a nested flex-1 scroller — Base UI's auto-height popup then never
        constrains the child, so the wheel has nothing to scroll. Footer stays in normal
        document flow (not sticky) so it cannot paint over cards.
      */}
      {/* initialFocus=false: default focus lands on the footer refresh button,
          which scrolls the viewport to the bottom when the popup overflows on a
          short screen — the top providers open hidden. */}
      <PopoverPopup
        side="bottom"
        align="end"
        initialFocus={false}
        className="max-h-[min(28rem,var(--available-height))] w-[min(18rem,calc(100vw-1.5rem))] p-0"
        viewportClassName="overflow-y-auto overscroll-contain p-0 [--viewport-inline-padding:0px]"
      >
        <div className="space-y-2 bg-background p-2.5">
          {fetchError ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-1.5">
              <p className="text-[11px] font-medium text-destructive">Refresh failed</p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">{fetchError}</p>
            </div>
          ) : null}
          {providers.length > 0 ? (
            <div className="flex flex-col gap-2">
              {providers.map((provider) => (
                <UsageProviderRow
                  key={provider.id}
                  history={history}
                  nowMs={nowMs}
                  provider={provider}
                  usage={data}
                />
              ))}
              {hasListPrice ? (
                <p className="px-0.5 text-[9px] leading-snug text-muted-foreground">
                  List = API list price (token spend at public rates), not your subscription bill.
                </p>
              ) : null}
            </div>
          ) : data === null && isRefreshing && !fetchError ? (
            <div className="rounded-lg border border-dashed border-border p-4 text-center">
              <p className="text-xs font-medium">Loading usage…</p>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border p-4 text-center">
              <p className="text-xs font-medium">Usage is unavailable</p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {fetchError && data === null
                  ? fetchError
                  : data?.errors?.every((error) => error.code === "no_credentials")
                    ? "No supported provider CLI login is available on this server."
                    : "T3 could not read provider usage yet. The next refresh will retry automatically."}
              </p>
            </div>
          )}
          {data?.errors?.length ? (
            <div className="space-y-1 rounded-lg bg-muted/35 px-2.5 py-1.5">
              {data.errors.map((error, index) => (
                <p
                  key={`${error.providerId ?? "provider"}-${error.code ?? "error"}-${error.message ?? index}`}
                  className="text-[10px] text-muted-foreground"
                >
                  <span className="font-medium text-foreground">
                    {formatProviderName(error.providerId)}
                  </span>
                  {error.message ? `: ${error.message}` : null}
                </p>
              ))}
              {providers.length > 0 ? (
                <p className="text-[10px] text-muted-foreground">
                  Showing last known data where available.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border/70 bg-muted/20 px-2.5 py-2">
          <span className="min-w-0 truncate text-[10px] text-muted-foreground">
            {isRefreshing
              ? "Refreshing…"
              : fetchError
                ? "Refresh failed"
                : data?.errors?.length || hasStaleProvider
                  ? `Partial${formatUpdatedAt(lastSuccessAt)}`
                  : `Every 5 min${formatUpdatedAt(lastSuccessAt)}`}
          </span>
          <Button
            aria-label="Refresh usage"
            className="size-7 shrink-0 p-0"
            onClick={() => void refresh(true)}
            size="sm"
            title="Refresh"
            variant="outline"
          >
            <RefreshCwIcon className={cn("size-3.5", isRefreshing && "animate-spin")} />
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
