import type { VpsFilesystem, VpsListener, VpsMemory, VpsProcess } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface CpuStatSample {
  readonly total: number;
  readonly idle: number;
}

export interface PsRow {
  readonly pid: number;
  readonly ppid: number;
  readonly user: string;
  readonly cpuPercent: number;
  readonly memPercent: number;
  readonly rssBytes: number;
  readonly elapsed: string;
  readonly command: string;
}

const FS_TYPE_SKIP = new Set([
  "devtmpfs",
  "proc",
  "sysfs",
  "cgroup",
  "cgroup2",
  "devpts",
  "securityfs",
  "pstore",
  "bpf",
  "debugfs",
  "tracefs",
  "configfs",
  "fusectl",
  "mqueue",
  "hugetlbfs",
  "ramfs",
  "squashfs",
  "autofs",
  "binfmt_misc",
  "nsfs",
  "efivarfs",
]);

const MOUNT_PREFIX_SKIP = ["/snap", "/sys", "/proc", "/dev", "/run/user", "/run/snapd"];

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toInt(value: string | undefined): number | null {
  const parsed = toNumber(value);
  return parsed === null ? null : Math.max(0, Math.round(parsed));
}

/** `NAME="value"` / `NAME=value` lines from /etc/os-release. */
export function parseOsRelease(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1];
    const raw = match[2];
    if (key === undefined || raw === undefined) continue;
    result[key] = raw.replace(/^"(.*)"$/, "$1");
  }
  return result;
}

export function parseMeminfo(content: string): VpsMemory | null {
  const values = new Map<string, number>();
  for (const line of content.split(/\r?\n/)) {
    const match = /^(\w+):\s+(\d+)(?:\s+kB)?$/.exec(line.trim());
    if (!match) continue;
    const key = match[1];
    const value = toInt(match[2]);
    if (key === undefined || value === null) continue;
    values.set(key, value * 1024);
  }
  const total = values.get("MemTotal");
  if (total === undefined) return null;
  const available = values.get("MemAvailable") ?? values.get("MemFree") ?? 0;
  const swapTotal = values.get("SwapTotal") ?? 0;
  const swapFree = values.get("SwapFree") ?? 0;
  return {
    totalBytes: total,
    availableBytes: Math.min(available, total),
    usedBytes: Math.max(0, total - available),
    cachedBytes: (values.get("Cached") ?? 0) + (values.get("Buffers") ?? 0),
    swapTotalBytes: swapTotal,
    swapUsedBytes: Math.max(0, swapTotal - swapFree),
  };
}

/** First `cpu` line of /proc/stat, as busy/idle jiffies. */
export function parseProcStatCpu(content: string): CpuStatSample | null {
  const line = content.split(/\r?\n/).find((candidate) => candidate.startsWith("cpu "));
  if (!line) return null;
  const fields = line.trim().split(/\s+/).slice(1).map(toNumber);
  if (fields.some((value) => value === null) || fields.length < 5) return null;
  const numbers = fields as ReadonlyArray<number>;
  const idle = (numbers[3] ?? 0) + (numbers[4] ?? 0);
  const total = numbers.reduce((sum, value) => sum + value, 0);
  return { total, idle };
}

export function cpuPercentBetween(first: CpuStatSample, second: CpuStatSample): number | null {
  const totalDelta = second.total - first.total;
  const idleDelta = second.idle - first.idle;
  if (totalDelta <= 0) return null;
  const percent = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Math.min(100, Math.max(0, Math.round(percent * 10) / 10));
}

/** Output of `df -PTk` (POSIX columns, 1K blocks, with fs type). */
export function parseDf(output: string): ReadonlyArray<VpsFilesystem> {
  const rows: VpsFilesystem[] = [];
  for (const line of output.split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 7) continue;
    const [device, fsType, totalText, usedText, availableText, , ...mountParts] = fields;
    const mountPoint = mountParts.join(" ");
    const total = toInt(totalText);
    const used = toInt(usedText);
    const available = toInt(availableText);
    if (
      !device ||
      !fsType ||
      !mountPoint ||
      total === null ||
      used === null ||
      available === null
    ) {
      continue;
    }
    if (total === 0) continue;
    if (FS_TYPE_SKIP.has(fsType)) continue;
    if (MOUNT_PREFIX_SKIP.some((prefix) => mountPoint.startsWith(prefix))) continue;
    rows.push({
      device,
      mountPoint,
      fsType,
      totalBytes: total * 1024,
      usedBytes: used * 1024,
      availableBytes: available * 1024,
      usePercent: Math.round((used / total) * 1000) / 10,
    });
  }
  return rows.sort((a, b) => b.totalBytes - a.totalBytes);
}

/** `Key=Value` lines from `systemctl show`. */
export function parseSystemctlShow(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    result[line.slice(0, index)] = line.slice(index + 1).trim();
  }
  return result;
}

function isoFromMillis(millis: number): string | null {
  if (!Number.isFinite(millis)) return null;
  return DateTime.formatIso(DateTime.makeUnsafe(Math.round(millis)));
}

/**
 * systemd renders timestamps three ways depending on version and flags: human
 * text, `@seconds`, or bare microseconds since the epoch. Zero means "never".
 */
export function parseSystemdTimestamp(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "n/a" || trimmed === "0") return null;
  if (/^@?\d+$/.test(trimmed)) {
    const numeric = Number(trimmed.replace("@", ""));
    if (!Number.isFinite(numeric) || numeric === 0) return null;
    const millis = trimmed.startsWith("@") ? numeric * 1000 : numeric / 1000;
    return isoFromMillis(millis);
  }
  const parsed = Date.parse(trimmed.replace(/^[A-Za-z]{3}\s+/, ""));
  return Number.isNaN(parsed) ? null : isoFromMillis(parsed);
}

export function parseSystemdBytes(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  // systemd reports an unset limit/measure as [not set] or the u64 sentinel.
  if (!/^\d+$/.test(trimmed)) return null;
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric) || numeric >= Number.MAX_SAFE_INTEGER) return null;
  return numeric;
}

/** `ps -eo pid=,ppid=,user=,pcpu=,pmem=,rss=,etime=,args=`. */
export function parsePsRows(output: string): ReadonlyArray<PsRow> {
  const rows: PsRow[] = [];
  const pattern = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(.+)$/;
  for (const line of output.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (!match) continue;
    const pid = toInt(match[1]);
    const ppid = toInt(match[2]);
    const cpuPercent = toNumber(match[4]);
    const memPercent = toNumber(match[5]);
    const rssKiB = toInt(match[6]);
    const user = match[3];
    const elapsed = match[7];
    const command = match[8];
    if (
      !pid ||
      ppid === null ||
      cpuPercent === null ||
      memPercent === null ||
      rssKiB === null ||
      !user ||
      !elapsed ||
      !command
    ) {
      continue;
    }
    rows.push({
      pid,
      ppid,
      user,
      cpuPercent,
      memPercent,
      rssBytes: rssKiB * 1024,
      elapsed,
      command,
    });
  }
  return rows;
}

function serverTreePids(rows: ReadonlyArray<PsRow>, serverPid: number): ReadonlySet<number> {
  const childrenByParent = new Map<number, number[]>();
  for (const row of rows) {
    const siblings = childrenByParent.get(row.ppid) ?? [];
    siblings.push(row.pid);
    childrenByParent.set(row.ppid, siblings);
  }
  const tree = new Set<number>([serverPid]);
  const queue = [serverPid];
  while (queue.length > 0) {
    const pid = queue.pop();
    if (pid === undefined) continue;
    for (const child of childrenByParent.get(pid) ?? []) {
      if (tree.has(child)) continue;
      tree.add(child);
      queue.push(child);
    }
  }
  return tree;
}

/** Heaviest processes first (CPU, then resident memory), sliced to `limit`. */
export function buildProcessList(
  rows: ReadonlyArray<PsRow>,
  serverPid: number,
  limit: number,
): ReadonlyArray<VpsProcess> {
  const tree = serverTreePids(rows, serverPid);
  return rows
    .map(
      (row): VpsProcess => ({
        pid: row.pid,
        ppid: row.ppid,
        user: row.user,
        cpuPercent: row.cpuPercent,
        memPercent: row.memPercent,
        rssBytes: row.rssBytes,
        elapsed: row.elapsed,
        command: row.command,
        isServerTree: tree.has(row.pid),
      }),
    )
    .sort((a, b) => b.cpuPercent - a.cpuPercent || b.rssBytes - a.rssBytes)
    .slice(0, Math.max(0, limit));
}

/** `ss -H -tulnp` rows. */
export function parseSsListeners(output: string): ReadonlyArray<VpsListener> {
  const listeners: VpsListener[] = [];
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5) continue;
    const [protocol, state, , , local, ...rest] = fields;
    if (!protocol || !local) continue;
    if (protocol.startsWith("tcp") && state !== "LISTEN") continue;
    const separator = local.lastIndexOf(":");
    if (separator < 0) continue;
    const address = local.slice(0, separator) || "*";
    const port = toInt(local.slice(separator + 1));
    if (port === null) continue;
    const processText = rest.join(" ");
    const processMatch = /users:\(\("([^"]+)",pid=(\d+)/.exec(processText);
    listeners.push({
      protocol,
      address,
      port,
      process: processMatch?.[1] ?? null,
      pid: processMatch?.[2] ? toInt(processMatch[2]) : null,
    });
  }
  return listeners.sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
}

/**
 * Upsert one `KEY=value` line in an `/etc/t3j.env`-style file.
 *
 * The same single-key edit `deploy/lib/env.sh`'s `env_set` does, so a token
 * typed into Settings lands in exactly the shape Install expects. Rewrites the
 * whole text rather than patching in place: every other key, comment and blank
 * line is preserved verbatim, and the caller writes it back atomically.
 */
export function upsertEnvKey(contents: string, key: string, value: string): string {
  const prefix = `${key}=`;
  const lines = contents.split("\n");
  let replaced = false;
  const next = lines.map((line) => {
    if (replaced || !line.startsWith(prefix)) return line;
    replaced = true;
    return `${prefix}${value}`;
  });
  if (!replaced) {
    while (next.length > 0 && next[next.length - 1] === "") next.pop();
    next.push(`${prefix}${value}`);
  }
  // Exactly one trailing newline, whether or not the file had one.
  return `${next.join("\n").replace(/\n+$/, "")}\n`;
}
