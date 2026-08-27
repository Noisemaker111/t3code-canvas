import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  VpsFilesystem,
  VpsProcess,
  VpsProcessSignal,
  VpsServiceAction,
  VpsServiceState,
  VpsSnapshot,
  VpsHealth,
  VpsHealthCheck,
} from "@t3tools/contracts";
import {
  AlertTriangleIcon,
  CpuIcon,
  HardDriveIcon,
  HeartPulseIcon,
  ListTreeIcon,
  NetworkIcon,
  RefreshCwIcon,
  ServerIcon,
  SettingsIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerConfigAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection, settingsPageShell } from "./settingsLayout";

const REFRESH_INTERVAL_MS = 10_000;
const PROCESS_LIMIT = 25;

function formatBytes(value: number | null): string {
  if (value === null) return "—";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let index = -1;
  let next = value;
  do {
    next /= 1024;
    index += 1;
  } while (next >= 1024 && index < units.length - 1);
  return `${next.toFixed(next >= 10 ? 0 : 1)} ${units[index]}`;
}

function formatDurationSeconds(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.max(0, Math.round(seconds))}s`;
}

function toneForPercent(percent: number): "default" | "warning" | "danger" {
  if (percent >= 90) return "danger";
  if (percent >= 75) return "warning";
  return "default";
}

function Meter({ percent, label }: { percent: number; label: string }) {
  const clamped = Math.min(100, Math.max(0, percent));
  const tone = toneForPercent(clamped);
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="min-w-0 truncate text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums text-foreground">{clamped.toFixed(1)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            tone === "danger"
              ? "bg-destructive"
              : tone === "warning"
                ? "bg-amber-500"
                : "bg-foreground/60",
          )}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string | undefined;
}) {
  return (
    <div className="min-w-0 px-4 py-3 sm:px-5">
      <div className="truncate text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
        {label}
      </div>
      <div className="mt-1 truncate font-mono text-sm font-semibold tabular-nums text-foreground">
        {value}
      </div>
      {hint ? (
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{hint}</div>
      ) : null}
    </div>
  );
}

function StatGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 divide-x divide-y divide-border/60 sm:grid-cols-4">
      {children}
    </div>
  );
}

function Table({ headers, children }: { headers: ReadonlyArray<string>; children: ReactNode }) {
  return (
    <ScrollArea chainVerticalScroll scrollFade hideScrollbars className="w-full max-w-full">
      <table className="w-full min-w-[520px] text-left text-xs">
        <thead className="border-b border-border/60 text-[11px] uppercase tracking-[0.08em] text-muted-foreground/70">
          <tr>
            {headers.map((header) => (
              <th
                key={header}
                className="whitespace-nowrap px-4 py-2.5 font-semibold first:sm:pl-5 last:sm:pr-5"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">{children}</tbody>
      </table>
    </ScrollArea>
  );
}

function EmptyRow({ columns, label }: { columns: number; label: string }) {
  return (
    <tr>
      <td colSpan={columns} className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
        {label}
      </td>
    </tr>
  );
}

function ServiceBadge({ service }: { service: VpsServiceState }) {
  const state = service.known ? `${service.activeState}/${service.subState}` : "not installed";
  const tone = !service.known
    ? "text-muted-foreground"
    : service.activeState === "active"
      ? "text-emerald-600 dark:text-emerald-400"
      : service.activeState === "failed"
        ? "text-destructive"
        : "text-amber-600 dark:text-amber-400";
  return <span className={cn("font-mono text-[11px]", tone)}>{state}</span>;
}

function FilesystemRow({ filesystem }: { filesystem: VpsFilesystem }) {
  return (
    <div className="border-t border-border/60 px-4 py-3 first:border-t-0 sm:px-5">
      <Meter
        percent={filesystem.usePercent}
        label={`${filesystem.mountPoint} · ${filesystem.fsType}`}
      />
      <div className="mt-1.5 text-[11px] text-muted-foreground">
        {formatBytes(filesystem.usedBytes)} used · {formatBytes(filesystem.availableBytes)} free of{" "}
        {formatBytes(filesystem.totalBytes)} · {filesystem.device}
      </div>
    </div>
  );
}

function ProcessRow({
  process,
  busy,
  onSignal,
}: {
  process: VpsProcess;
  busy: boolean;
  onSignal: (pid: number, signal: VpsProcessSignal) => void;
}) {
  return (
    <tr className={cn(process.isServerTree && "bg-muted/40")}>
      <td className="px-4 py-2 font-mono tabular-nums sm:pl-5">{process.pid}</td>
      <td className="px-4 py-2 font-mono tabular-nums">{process.cpuPercent.toFixed(1)}%</td>
      <td className="px-4 py-2 font-mono tabular-nums">{formatBytes(process.rssBytes)}</td>
      <td className="max-w-[16rem] px-4 py-2">
        <span className="block truncate font-mono text-[11px]" title={process.command}>
          {process.command}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {process.user} · {process.elapsed}
        </span>
      </td>
      <td className="px-4 py-2 sm:pr-5">
        <div className="flex justify-end gap-1">
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => onSignal(process.pid, "SIGTERM")}
          >
            Term
          </Button>
          <Button
            size="xs"
            variant="ghost"
            className="text-destructive"
            disabled={busy}
            onClick={() => onSignal(process.pid, "SIGKILL")}
          >
            Kill
          </Button>
        </div>
      </td>
    </tr>
  );
}

function SectionErrors({ snapshot }: { snapshot: VpsSnapshot | null }) {
  if (!snapshot || snapshot.errors.length === 0) return null;
  return (
    <div className="space-y-1.5 rounded-2xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-xs text-destructive">
      {snapshot.errors.map((error) => (
        <div key={`${error.section}-${error.message}`} className="flex items-start gap-2">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>
            <span className="font-semibold capitalize">{error.section}</span>: {error.message}
          </span>
        </div>
      ))}
    </div>
  );
}

const HEALTH_TONE: Record<VpsHealthCheck["status"], string> = {
  ok: "text-muted-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  fail: "text-destructive",
};

/**
 * Remediation stops being a root-shell recipe the moment it has a button. Only
 * checks that know how to repair themselves offer one.
 */
/**
 * The one credential the board cannot work without.
 *
 * It opens every pull request itself, so a box with no forge token runs a card
 * to completion and then fails at the last step — and setting it used to mean a
 * root shell and an editor on /etc/t3j.env. Write-only on purpose: what you
 * need back is whether `forge.auth` passes, which is the row right above.
 */
function ForgeTokenRow({
  health,
  busy,
  onSave,
}: {
  health: VpsHealth | null;
  busy: boolean;
  onSave: (token: string) => void;
}) {
  const [token, setToken] = useState("");
  const find = (id: string) => health?.checks.find((check) => check.id === id) ?? null;
  const cli = find("forge.cli");
  const auth = find("forge.auth");
  // forge.auth passes vacuously when there is no CLI to ask, so forge.cli is
  // what decides whether "authenticated" means anything here.
  const description =
    cli !== null && cli.status !== "ok"
      ? `No forge CLI on this box — ${cli.detail}. Saving a token installs and authenticates gh.`
      : auth === null
        ? "Personal access token with `repo` scope. Saved to /etc/t3j.env, then gh is authenticated with it."
        : auth.status === "ok"
          ? `Authenticated — ${auth.detail}. Paste a new token to replace it.`
          : `${auth.detail} Paste a token with \`repo\` scope to fix it.`;
  return (
    <SettingsRow
      title="GitHub token"
      description={description}
      control={
        <div className="flex items-center gap-2">
          <input
            type="password"
            autoComplete="off"
            placeholder="ghp_…"
            className="h-8 w-48 rounded-md bg-raised px-2 font-mono text-xs outline-none focus:border-ring"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <Button
            size="xs"
            variant="outline"
            disabled={busy || token.trim().length === 0}
            onClick={() => {
              onSave(token.trim());
              setToken("");
            }}
          >
            Save
          </Button>
        </div>
      }
    />
  );
}

function HealthSection({
  health,
  busy,
  pending,
  onRun,
  onSaveForgeToken,
}: {
  health: VpsHealth | null;
  busy: boolean;
  pending: boolean;
  onRun: (fix: boolean) => void;
  onSaveForgeToken: (token: string) => void;
}) {
  const fixable = (health?.checks ?? []).filter(
    (check) => check.fixable && check.status !== "ok",
  ).length;

  return (
    <SettingsSection
      title="Health"
      icon={<HeartPulseIcon className="size-3.5" />}
      headerAction={
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {health ? formatRelativeTimeLabel(health.at) : "—"}
          </span>
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => onRun(false)}>
            Re-check
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy || fixable === 0}
            onClick={() => onRun(true)}
          >
            {fixable > 0 ? `Fix ${fixable}` : "Fix"}
          </Button>
        </div>
      }
    >
      <Table headers={["Check", "What it found", "Seen"]}>
        {(health?.checks.length ?? 0) === 0 ? (
          <EmptyRow columns={3} label={pending || busy ? "Probing…" : "No health data yet."} />
        ) : (
          health?.checks.map((check) => (
            <tr key={check.id}>
              <td className="px-4 py-2 sm:pl-5">
                <div className={cn("font-mono text-[11px]", HEALTH_TONE[check.status])}>
                  {check.status === "ok" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL"}{" "}
                  {check.id}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">{check.title}</div>
              </td>
              <td className="px-4 py-2 text-[11px] text-muted-foreground">
                {check.detail}
                {check.fixed === true ? (
                  <span className="ml-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                    (fixed and re-checked)
                  </span>
                ) : null}
                {check.fixError ? (
                  <div className="mt-0.5 text-[11px] text-red-600 dark:text-red-400">
                    fix could not run: {check.fixError}
                  </div>
                ) : null}
              </td>
              <td className="px-4 py-2 text-[11px] text-muted-foreground tabular-nums sm:pr-5">
                {check.seenInLastDay > 1 ? `${check.seenInLastDay}× today` : "—"}
              </td>
            </tr>
          ))
        )}
      </Table>
      <ForgeTokenRow health={health} busy={busy} onSave={onSaveForgeToken} />
    </SettingsSection>
  );
}

export function VpsSettingsPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const [includeDiskUsage, setIncludeDiskUsage] = useState(false);
  const [busyUnit, setBusyUnit] = useState<string | null>(null);
  const [busyPid, setBusyPid] = useState<number | null>(null);

  const { data, error, isPending, refresh } = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.vpsSnapshot({
          environmentId,
          input: { processLimit: PROCESS_LIMIT, includeDiskUsage },
        }),
  );

  useEffect(() => {
    const id = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const serviceAction = useAtomCommand(serverEnvironment.vpsServiceAction, {
    reportFailure: false,
  });
  const signalProcess = useAtomCommand(serverEnvironment.vpsSignalProcess, {
    reportFailure: false,
  });
  const runHealth = useAtomCommand(serverEnvironment.vpsRunHealth, { reportFailure: false });
  const [health, setHealth] = useState<VpsHealth | null>(null);
  const [healthBusy, setHealthBusy] = useState(false);

  const checkHealth = useCallback(
    (fix: boolean) => {
      if (environmentId === null) return;
      setHealthBusy(true);
      void (async () => {
        const result = await runHealth({ environmentId, input: { fix } });
        setHealthBusy(false);
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const failure = squashAtomCommandFailure(result);
            toastManager.add({
              type: "error",
              title: fix ? "Could not fix the box" : "Could not run health checks",
              description: failure instanceof Error ? failure.message : "The health run failed.",
            });
          }
          return;
        }
        setHealth(result.value);
        if (fix) {
          const repaired = result.value.checks.filter((check) => check.fixed === true);
          toastManager.add({
            type: repaired.length > 0 ? "success" : "info",
            title:
              repaired.length > 0
                ? `Fixed ${repaired.map((check) => check.id).join(", ")}`
                : "Nothing left to fix here",
          });
        }
        refresh();
      })();
    },
    [environmentId, refresh, runHealth],
  );

  const setForgeToken = useAtomCommand(serverEnvironment.vpsSetForgeToken, {
    reportFailure: false,
  });

  const saveForgeToken = useCallback(
    (token: string) => {
      if (environmentId === null) return;
      setHealthBusy(true);
      void (async () => {
        const result = await setForgeToken({ environmentId, input: { token } });
        setHealthBusy(false);
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const failure = squashAtomCommandFailure(result);
            toastManager.add({
              type: "error",
              title: "Could not save the GitHub token",
              description: failure instanceof Error ? failure.message : "The write failed.",
            });
          }
          return;
        }
        setHealth(result.value);
        const auth = result.value.checks.find((check) => check.id === "forge.auth");
        toastManager.add({
          type: auth?.status === "ok" ? "success" : "error",
          title: auth?.status === "ok" ? "GitHub token saved" : "Token saved but gh is not authed",
          ...(auth?.status === "ok" ? {} : { description: auth?.detail ?? "" }),
        });
        refresh();
      })();
    },
    [environmentId, refresh, setForgeToken],
  );

  const runServiceAction = useCallback(
    (unit: string, action: VpsServiceAction) => {
      if (environmentId === null) return;
      if (action !== "start" && !window.confirm(`${action} ${unit}?`)) return;
      setBusyUnit(unit);
      void (async () => {
        const result = await serviceAction({ environmentId, input: { unit, action } });
        setBusyUnit(null);
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const failure = squashAtomCommandFailure(result);
            toastManager.add({
              type: "error",
              title: `Could not ${action} ${unit}`,
              description: failure instanceof Error ? failure.message : `${action} failed.`,
            });
          }
          return;
        }
        toastManager.add({ type: "success", title: `${unit}: ${action} sent` });
        refresh();
      })();
    },
    [environmentId, refresh, serviceAction],
  );

  const runSignal = useCallback(
    (pid: number, signal: VpsProcessSignal) => {
      if (environmentId === null) return;
      if (!window.confirm(`Send ${signal} to process ${pid}?`)) return;
      setBusyPid(pid);
      void (async () => {
        const result = await signalProcess({ environmentId, input: { pid, signal } });
        setBusyPid(null);
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const failure = squashAtomCommandFailure(result);
            toastManager.add({
              type: "error",
              title: `Could not send ${signal}`,
              description: failure instanceof Error ? failure.message : `${signal} failed.`,
            });
          }
          return;
        }
        refresh();
      })();
    },
    [environmentId, refresh, signalProcess],
  );

  const host = data?.host ?? null;
  const memory = data?.memory ?? null;
  const memoryPercent = useMemo(
    () => (memory && memory.totalBytes > 0 ? (memory.usedBytes / memory.totalBytes) * 100 : 0),
    [memory],
  );
  const swapPercent =
    memory && memory.swapTotalBytes > 0 ? (memory.swapUsedBytes / memory.swapTotalBytes) * 100 : 0;
  const loadPercent =
    host && host.cpuCount > 0 ? Math.min(100, (host.load1 / host.cpuCount) * 100) : 0;

  return settingsPageShell(
    embedded,
    <>
      <SettingsSection
        title="Host"
        icon={<ServerIcon className="size-3.5" />}
        headerAction={
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">
              {data ? formatRelativeTimeLabel(data.readAt) : "—"}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Refresh VPS snapshot"
              disabled={isPending}
              onClick={refresh}
            >
              <RefreshCwIcon className={cn("size-3.5", isPending && "animate-spin")} />
            </Button>
          </div>
        }
      >
        <StatGrid>
          <Stat label="Hostname" value={host?.hostname ?? "…"} hint={host?.osName ?? undefined} />
          <Stat
            label="Uptime"
            value={host ? formatDurationSeconds(host.uptimeSeconds) : "…"}
            hint={host ? `booted ${formatRelativeTimeLabel(host.bootedAt)}` : undefined}
          />
          <Stat
            label="Kernel"
            value={host?.kernel ?? "…"}
            hint={host ? `${host.arch} · node ${host.nodeVersion}` : undefined}
          />
          <Stat
            label="T3J server"
            value={host ? `pid ${host.serverPid}` : "…"}
            hint={host ? `up ${formatDurationSeconds(host.serverUptimeSeconds)}` : undefined}
          />
        </StatGrid>
        <SettingsRow title="Working directory" description={serverConfig?.cwd ?? "Unknown"} />
      </SettingsSection>

      <HealthSection
        health={health ?? data?.health ?? null}
        busy={healthBusy}
        pending={isPending}
        onRun={checkHealth}
        onSaveForgeToken={saveForgeToken}
      />

      {error ? (
        <div className="rounded-2xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      <SectionErrors snapshot={data} />

      <SettingsSection title="Load" icon={<CpuIcon className="size-3.5" />}>
        <div className="space-y-4 px-4 py-4 sm:px-5">
          <Meter
            percent={host?.cpuPercent ?? loadPercent}
            label={
              host
                ? `CPU · ${host.cpuCount} core${host.cpuCount === 1 ? "" : "s"}${
                    host.cpuModel ? ` · ${host.cpuModel}` : ""
                  }`
                : "CPU"
            }
          />
          <Meter
            percent={memoryPercent}
            label={
              memory
                ? `Memory · ${formatBytes(memory.usedBytes)} of ${formatBytes(memory.totalBytes)}`
                : "Memory"
            }
          />
          {memory && memory.swapTotalBytes > 0 ? (
            <Meter
              percent={swapPercent}
              label={`Swap · ${formatBytes(memory.swapUsedBytes)} of ${formatBytes(memory.swapTotalBytes)}`}
            />
          ) : null}
          <div className="text-[11px] text-muted-foreground">
            {host
              ? `Load ${host.load1.toFixed(2)} / ${host.load5.toFixed(2)} / ${host.load15.toFixed(2)} (1m / 5m / 15m)`
              : "Load —"}
            {memory ? ` · ${formatBytes(memory.cachedBytes)} cached` : null}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Storage"
        icon={<HardDriveIcon className="size-3.5" />}
        headerAction={
          <Button
            size="xs"
            variant="outline"
            onClick={() => setIncludeDiskUsage((value) => !value)}
          >
            {includeDiskUsage ? "Hide directory sizes" : "Measure directories"}
          </Button>
        }
      >
        {(data?.filesystems.length ?? 0) === 0 ? (
          <div className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
            {isPending ? "Reading mounts…" : "No filesystems reported."}
          </div>
        ) : (
          data?.filesystems.map((filesystem) => (
            <FilesystemRow key={filesystem.mountPoint} filesystem={filesystem} />
          ))
        )}
        {includeDiskUsage ? (
          <div className="border-t border-border/60 px-4 py-3 sm:px-5">
            {data && data.diskUsage.length > 0 ? (
              <ul className="space-y-1 text-[11px]">
                {data.diskUsage.map((entry) => (
                  <li key={entry.path} className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-muted-foreground">
                      {entry.label} · <span className="font-mono">{entry.path}</span>
                    </span>
                    <span className="font-mono tabular-nums">
                      {entry.error ?? formatBytes(entry.sizeBytes)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-xs text-muted-foreground">Measuring directory sizes…</span>
            )}
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Services" icon={<SettingsIcon className="size-3.5" />}>
        <Table headers={["Unit", "State", "Since", "Memory", ""]}>
          {(data?.services.length ?? 0) === 0 ? (
            <EmptyRow columns={5} label={isPending ? "Reading units…" : "No managed units."} />
          ) : (
            data?.services.map((service) => (
              <tr key={service.unit}>
                <td className="px-4 py-2 sm:pl-5">
                  <div className="font-mono text-[11px] text-foreground">{service.unit}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {service.description ?? (service.enabled ? `${service.enabled}` : "")}
                  </div>
                </td>
                <td className="px-4 py-2">
                  <ServiceBadge service={service} />
                  {service.mainPid ? (
                    <div className="font-mono text-[11px] text-muted-foreground">
                      pid {service.mainPid}
                    </div>
                  ) : null}
                </td>
                <td className="px-4 py-2 text-[11px] text-muted-foreground">
                  {service.nextRunAt
                    ? `next ${formatRelativeTimeLabel(service.nextRunAt)}`
                    : service.since
                      ? formatRelativeTimeLabel(service.since)
                      : "—"}
                </td>
                <td className="px-4 py-2 font-mono tabular-nums">
                  {formatBytes(service.memoryBytes)}
                </td>
                <td className="px-4 py-2 sm:pr-5">
                  <div className="flex justify-end gap-1">
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={!service.known || busyUnit === service.unit}
                      onClick={() => runServiceAction(service.unit, "restart")}
                    >
                      Restart
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={!service.known || service.isSelf || busyUnit === service.unit}
                      onClick={() =>
                        runServiceAction(
                          service.unit,
                          service.activeState === "active" ? "stop" : "start",
                        )
                      }
                    >
                      {service.activeState === "active" ? "Stop" : "Start"}
                    </Button>
                  </div>
                </td>
              </tr>
            ))
          )}
        </Table>
      </SettingsSection>

      <SettingsSection
        title="Processes"
        icon={<ListTreeIcon className="size-3.5" />}
        headerAction={
          <span className="text-[11px] text-muted-foreground">
            {data ? `top ${data.processes.length} of ${data.processCount}` : "—"}
          </span>
        }
      >
        <Table headers={["PID", "CPU", "Memory", "Command", ""]}>
          {(data?.processes.length ?? 0) === 0 ? (
            <EmptyRow columns={5} label={isPending ? "Reading processes…" : "No processes."} />
          ) : (
            data?.processes.map((entry) => (
              <ProcessRow
                key={entry.pid}
                process={entry}
                busy={busyPid === entry.pid}
                onSignal={runSignal}
              />
            ))
          )}
        </Table>
      </SettingsSection>

      <SettingsSection title="Listening ports" icon={<NetworkIcon className="size-3.5" />}>
        <Table headers={["Port", "Protocol", "Address", "Process"]}>
          {(data?.listeners.length ?? 0) === 0 ? (
            <EmptyRow
              columns={4}
              label={isPending ? "Reading sockets…" : "No listening sockets."}
            />
          ) : (
            data?.listeners.map((listener) => (
              <tr key={`${listener.protocol}-${listener.address}-${listener.port}`}>
                <td className="px-4 py-2 font-mono tabular-nums sm:pl-5">{listener.port}</td>
                <td className="px-4 py-2 font-mono text-[11px] text-muted-foreground">
                  {listener.protocol}
                </td>
                <td className="px-4 py-2 font-mono text-[11px]">{listener.address}</td>
                <td className="px-4 py-2 text-[11px] text-muted-foreground sm:pr-5">
                  {listener.process
                    ? `${listener.process}${listener.pid ? ` (${listener.pid})` : ""}`
                    : "—"}
                </td>
              </tr>
            ))
          )}
        </Table>
      </SettingsSection>
    </>,
  );
}
