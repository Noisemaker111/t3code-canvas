/**
 * VpsHostService — the devbox, as observability.
 *
 * This app is the only console the VPS has, so Settings → VPS needs host facts
 * (load, memory, disks, systemd units, processes, listening ports) and a small
 * amount of control over them. Everything is read on demand: `/proc` through
 * the platform file system, the rest through short-lived `df` / `systemctl` /
 * `ps` / `ss` invocations. Each section fails on its own so a slim image
 * without `ss`, or a laptop without systemd, degrades one card instead of the
 * page.
 *
 * @module VpsHostService
 */
import type {
  VpsDiskUsageEntry,
  VpsFilesystem,
  VpsGetSnapshotInput,
  VpsListener,
  VpsProcess,
  VpsSectionError,
  VpsServiceActionInput,
  VpsServiceActionResult,
  VpsServiceState,
  VpsSignalProcessInput,
  VpsSignalProcessResult,
  VpsSnapshot,
  VpsHealth,
  VpsRunHealthInput,
  VpsSetForgeTokenInput,
} from "@t3tools/contracts";
import { VpsHostError } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as HealthChecks from "../health/checks.ts";
import * as HealthEnv from "../health/env.ts";
import * as HealthIncidentLog from "../health/incidentLog.ts";
import * as HealthRunner from "../health/runner.ts";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as NodeOS from "node:os";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import {
  buildProcessList,
  cpuPercentBetween,
  parseDf,
  parseMeminfo,
  parseOsRelease,
  parseProcStatCpu,
  parsePsRows,
  parseSsListeners,
  parseSystemctlShow,
  parseSystemdBytes,
  parseSystemdTimestamp,
  upsertEnvKey,
} from "./vpsHostParse.ts";

const COMMAND_TIMEOUT = Duration.seconds(10);
const DISK_USAGE_TIMEOUT = Duration.seconds(45);
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_PROCESS_LIMIT = 20;
const MAX_PROCESS_LIMIT = 200;
// Window between the two /proc/stat reads that yield whole-box CPU percent.
const CPU_SAMPLE_WINDOW = Duration.millis(250);

const DEFAULT_UNITS = ["t3j.service", "vps-code-pull.service", "vps-code-pull.timer"] as const;

const SYSTEMCTL_PROPERTIES = [
  "Id",
  "Description",
  "LoadState",
  "ActiveState",
  "SubState",
  "UnitFileState",
  "StateChangeTimestamp",
  "ActiveEnterTimestamp",
  "MainPID",
  "MemoryCurrent",
  "NextElapseUSecRealtime",
] as const;

interface VpsConfig {
  readonly units: ReadonlyArray<string>;
  readonly selfUnit: string;
  readonly diskUsagePaths: ReadonlyArray<{ readonly label: string; readonly path: string }>;
  /** The deploy checkout, when this box has one. Where `deploy/*.sh` live. */
  readonly repoPath: string | null;
  /** The unit's EnvironmentFile — what Install and the board loop both read. */
  readonly envFile: string;
}

function resolveConfig(): VpsConfig {
  const env = process.env;
  const configured = (env.T3CODE_VPS_UNITS ?? "")
    .split(",")
    .map((unit) => unit.trim())
    .filter((unit) => unit.length > 0);
  const releasesRoot = env.T3CODE_RELEASE_ROOT ?? "/opt/t3j/releases";
  const installLogDir = (env.T3CODE_INSTALL_LOG_DIR ?? "").trim() || "/var/lib/t3j/installs";
  const repoPath = (env.T3CODE_VPS_REPO_PATH ?? "").trim();
  const projectsDir = (env.T3CODE_PROJECTS_DIR ?? "").trim() || `${NodeOS.homedir()}/projects`;
  return {
    units: configured.length > 0 ? configured : DEFAULT_UNITS,
    selfUnit: (env.T3CODE_VPS_SELF_UNIT ?? "").trim() || "t3j.service",
    diskUsagePaths: [
      { label: "Releases", path: releasesRoot },
      { label: "Install logs", path: installLogDir },
      { label: "Projects", path: projectsDir },
      ...(repoPath.length > 0 ? [{ label: "vps-code checkout", path: repoPath }] : []),
    ],
    repoPath: repoPath.length > 0 ? repoPath : null,
    envFile: (env.T3J_ENV_FILE ?? "").trim() || "/etc/t3j.env",
  };
}

interface CommandOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class VpsHost extends Context.Service<
  VpsHost,
  {
    readonly snapshot: (input: VpsGetSnapshotInput) => Effect.Effect<VpsSnapshot, VpsHostError>;
    /** Probe every health check, optionally running the autofixes first. */
    readonly runHealth: (input: VpsRunHealthInput) => Effect.Effect<VpsHealth, VpsHostError>;
    /** Write the forge token, re-run the forge provisioning, re-probe health. */
    readonly setForgeToken: (
      input: VpsSetForgeTokenInput,
    ) => Effect.Effect<VpsHealth, VpsHostError>;
    readonly serviceAction: (
      input: VpsServiceActionInput,
    ) => Effect.Effect<VpsServiceActionResult, VpsHostError>;
    readonly signalProcess: (
      input: VpsSignalProcessInput,
    ) => Effect.Effect<VpsSignalProcessResult, VpsHostError>;
  }
>()("t3/vps/VpsHostService/VpsHost") {}

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const config = resolveConfig();
  const platform = yield* HostProcessPlatform;
  const supported = platform === "linux";

  const runCommand = (
    command: string,
    args: ReadonlyArray<string>,
    timeout: Duration.Duration = COMMAND_TIMEOUT,
  ): Effect.Effect<CommandOutput, VpsHostError> =>
    Effect.gen(function* () {
      const child = yield* spawner.spawn(ChildProcess.make(command, args, {}));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout, maxBytes: MAX_OUTPUT_BYTES }),
          collectUint8StreamText({ stream: child.stderr, maxBytes: MAX_OUTPUT_BYTES }),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { exitCode, stdout: stdout.text, stderr: stderr.text.trim() };
    }).pipe(
      Effect.scoped,
      Effect.timeout(timeout),
      Effect.mapError(
        (cause) =>
          new VpsHostError({
            operation: command,
            detail: `Failed to run \`${command}\`.`,
            cause,
          }),
      ),
    );

  const readTextFile = (path: string): Effect.Effect<string | null> =>
    fs.readFileString(path).pipe(Effect.orElseSucceed(() => null));

  const readCpuPercent = Effect.gen(function* () {
    const first = parseProcStatCpu((yield* readTextFile("/proc/stat")) ?? "");
    if (!first) return null;
    yield* Effect.sleep(CPU_SAMPLE_WINDOW);
    const second = parseProcStatCpu((yield* readTextFile("/proc/stat")) ?? "");
    return second ? cpuPercentBetween(first, second) : null;
  });

  const readHost = Effect.gen(function* () {
    const arch = yield* HostProcessArchitecture;
    const [uptimeRaw, loadRaw, cpuInfoRaw, osReleaseRaw, cpuPercent] = yield* Effect.all(
      [
        readTextFile("/proc/uptime"),
        readTextFile("/proc/loadavg"),
        readTextFile("/proc/cpuinfo"),
        readTextFile("/etc/os-release"),
        readCpuPercent,
      ],
      { concurrency: "unbounded" },
    );
    const uptimeSeconds = Math.max(
      0,
      Math.round(Number.parseFloat(uptimeRaw ?? "") || NodeOS.uptime()),
    );
    const load = (loadRaw ?? "").trim().split(/\s+/);
    const cpuModel = /^model name\s*:\s*(.+)$/m.exec(cpuInfoRaw ?? "")?.[1]?.trim() ?? null;
    const osName = osReleaseRaw ? (parseOsRelease(osReleaseRaw).PRETTY_NAME ?? null) : null;
    const now = yield* DateTime.now;
    return {
      hostname: NodeOS.hostname(),
      osName,
      kernel: NodeOS.release(),
      arch,
      uptimeSeconds,
      bootedAt: DateTime.formatIso(DateTime.subtract(now, { seconds: uptimeSeconds })),
      cpuModel,
      cpuCount: Math.max(1, NodeOS.cpus().length),
      load1: Number.parseFloat(load[0] ?? "") || 0,
      load5: Number.parseFloat(load[1] ?? "") || 0,
      load15: Number.parseFloat(load[2] ?? "") || 0,
      cpuPercent,
      serverPid: process.pid,
      serverUptimeSeconds: Math.max(0, Math.round(process.uptime())),
      nodeVersion: process.version,
    };
  });

  const readFilesystems = runCommand("df", ["-PTk"]).pipe(
    Effect.map((output) => parseDf(output.stdout)),
  );

  const readDiskUsage = (
    entry: (typeof config.diskUsagePaths)[number],
  ): Effect.Effect<VpsDiskUsageEntry> =>
    runCommand("du", ["-sxb", entry.path], DISK_USAGE_TIMEOUT).pipe(
      Effect.map((output): VpsDiskUsageEntry => {
        const size = Number.parseInt(output.stdout.trim().split(/\s+/)[0] ?? "", 10);
        if (output.exitCode !== 0 && !Number.isInteger(size)) {
          return {
            label: entry.label,
            path: entry.path,
            sizeBytes: null,
            error: output.stderr || "Not readable",
          };
        }
        return {
          label: entry.label,
          path: entry.path,
          sizeBytes: Number.isInteger(size) ? size : null,
          error: null,
        };
      }),
      Effect.catch((error) =>
        Effect.succeed<VpsDiskUsageEntry>({
          label: entry.label,
          path: entry.path,
          sizeBytes: null,
          error: error.detail,
        }),
      ),
    );

  const readService = (unit: string): Effect.Effect<VpsServiceState, VpsHostError> =>
    runCommand("systemctl", [
      "show",
      unit,
      "--no-pager",
      ...SYSTEMCTL_PROPERTIES.flatMap((property) => ["--property", property]),
    ]).pipe(
      Effect.map((output): VpsServiceState => {
        const values = parseSystemctlShow(output.stdout);
        const loadState = values.LoadState ?? "unknown";
        const mainPid = Number.parseInt(values.MainPID ?? "", 10);
        return {
          unit,
          description:
            values.Description && values.Description !== unit ? values.Description : null,
          loadState,
          activeState: values.ActiveState ?? "unknown",
          subState: values.SubState ?? "unknown",
          enabled: values.UnitFileState || null,
          since:
            parseSystemdTimestamp(values.StateChangeTimestamp) ??
            parseSystemdTimestamp(values.ActiveEnterTimestamp),
          mainPid: Number.isInteger(mainPid) && mainPid > 0 ? mainPid : null,
          memoryBytes: parseSystemdBytes(values.MemoryCurrent),
          known: loadState !== "not-found" && loadState !== "unknown",
          isSelf: unit === config.selfUnit,
          nextRunAt: parseSystemdTimestamp(values.NextElapseUSecRealtime),
        };
      }),
    );

  const readServices = Effect.forEach(config.units, readService, { concurrency: 4 });

  const readProcesses = (
    limit: number,
  ): Effect.Effect<{ processes: ReadonlyArray<VpsProcess>; total: number }, VpsHostError> =>
    runCommand("ps", ["-eo", "pid=,ppid=,user=,pcpu=,pmem=,rss=,etime=,args="]).pipe(
      Effect.map((output) => {
        const rows = parsePsRows(output.stdout);
        return { processes: buildProcessList(rows, process.pid, limit), total: rows.length };
      }),
    );

  const readListeners: Effect.Effect<ReadonlyArray<VpsListener>, VpsHostError> = runCommand("ss", [
    "-H",
    "-tulnp",
  ]).pipe(Effect.map((output) => parseSsListeners(output.stdout)));

  const section = <A>(
    name: VpsSectionError["section"],
    effect: Effect.Effect<A, VpsHostError>,
    fallback: A,
  ): Effect.Effect<{ value: A; error: VpsSectionError | null }> =>
    effect.pipe(
      Effect.map((value) => ({ value, error: null as VpsSectionError | null })),
      Effect.catch((error) =>
        Effect.succeed({
          value: fallback,
          error: { section: name, message: error.detail } satisfies VpsSectionError,
        }),
      ),
    );

  /**
   * The health registry, rendered for the Settings panel. Remediation stops
   * being a root shell recipe the moment it has a button.
   */
  const runHealth: VpsHost["Service"]["runHealth"] = (input) =>
    Effect.gen(function* () {
      const env = HealthEnv.makeHealthEnv(HealthEnv.healthPathsFromEnvironment());
      const report = yield* Effect.promise(() =>
        HealthRunner.runHealthChecks(HealthChecks.HEALTH_CHECKS, env, {
          fix: input.fix === true,
        }),
      );
      HealthIncidentLog.recordHealthReport(report);
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      return {
        at: report.at,
        ok: report.ok,
        checks: report.checks.map((outcome) => ({
          id: outcome.id,
          title: outcome.title,
          severity: outcome.severity,
          status: outcome.status,
          detail: outcome.detail,
          ...(outcome.fixed === undefined ? {} : { fixed: outcome.fixed }),
          ...(outcome.fixError === undefined ? {} : { fixError: outcome.fixError }),
          seenInLastDay: HealthIncidentLog.countRecent(outcome.id, 24 * 60 * 60 * 1000, nowMs),
          fixable: HealthChecks.HEALTH_CHECKS.some(
            (check) => check.id === outcome.id && check.autofix !== undefined,
          ),
        })),
      } satisfies VpsHealth;
    });

  /**
   * The token the board opens pull requests with, set from Settings.
   *
   * The secret goes to disk here rather than through the script's argv or env:
   * `ensure-forge.sh` reads `GH_TOKEN` back out of the env file itself, so it
   * never has to be handed to a child process. Provisioning is best-effort —
   * the re-probed health is the answer either way, and `forge.auth`'s detail
   * says more about what went wrong than a thrown error would.
   */
  const setForgeToken: VpsHost["Service"]["setForgeToken"] = (input) =>
    Effect.gen(function* () {
      const path = config.envFile;
      const existing = (yield* readTextFile(path)) ?? "";
      yield* fs.writeFileString(path, upsertEnvKey(existing, "GH_TOKEN", input.token.trim())).pipe(
        Effect.mapError(
          (cause) =>
            new VpsHostError({
              operation: "vps.setForgeToken",
              detail: `Could not write ${path}.`,
              cause,
            }),
        ),
      );
      yield* fs.chmod(path, 0o600).pipe(Effect.ignore);

      if (config.repoPath) {
        yield* runCommand(
          "bash",
          [`${config.repoPath}/deploy/ensure-forge.sh`, path],
          Duration.minutes(5),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("vps.setForgeToken: ensure-forge.sh failed after saving the token", {
              cause: String(cause),
            }),
          ),
        );
      } else {
        yield* Effect.logWarning(
          "vps.setForgeToken: no deploy checkout (T3CODE_VPS_REPO_PATH unset) — token saved " +
            "but forge provisioning did not run",
        );
      }
      return yield* runHealth({});
    });

  const snapshot: VpsHost["Service"]["snapshot"] = (input) =>
    Effect.gen(function* () {
      const readAt = DateTime.formatIso(yield* DateTime.now);
      if (!supported) {
        return {
          readAt,
          supported: false,
          host: null,
          memory: null,
          filesystems: [],
          diskUsage: [],
          services: [],
          processes: [],
          processCount: 0,
          listeners: [],
          health: null,
          errors: [
            {
              section: "host" as const,
              message: `Host metrics are only collected on Linux (this server runs ${platform}).`,
            },
          ],
        };
      }

      const limit = Math.min(MAX_PROCESS_LIMIT, input.processLimit ?? DEFAULT_PROCESS_LIMIT);
      const [host, memoryRaw, filesystems, services, processes, listeners, diskUsage] =
        yield* Effect.all(
          [
            section("host", readHost, null),
            readTextFile("/proc/meminfo"),
            section("filesystems", readFilesystems, [] as ReadonlyArray<VpsFilesystem>),
            section("services", readServices, [] as ReadonlyArray<VpsServiceState>),
            section("processes", readProcesses(limit), {
              processes: [] as ReadonlyArray<VpsProcess>,
              total: 0,
            }),
            section("listeners", readListeners, [] as ReadonlyArray<VpsListener>),
            input.includeDiskUsage === true
              ? Effect.forEach(config.diskUsagePaths, readDiskUsage, { concurrency: 2 })
              : Effect.succeed([] as ReadonlyArray<VpsDiskUsageEntry>),
          ],
          { concurrency: "unbounded" },
        );

      const memory = memoryRaw ? parseMeminfo(memoryRaw) : null;
      const memoryError: VpsSectionError | null =
        memory === null ? { section: "memory", message: "/proc/meminfo is not readable." } : null;
      const errors = [
        host.error,
        memoryError,
        filesystems.error,
        services.error,
        processes.error,
        listeners.error,
      ].filter((error): error is VpsSectionError => error !== null);

      return {
        readAt,
        supported: true,
        host: host.value,
        memory,
        filesystems: filesystems.value,
        diskUsage,
        services: services.value,
        processes: processes.value.processes,
        processCount: processes.value.total,
        listeners: listeners.value,
        health: yield* runHealth({}).pipe(Effect.catch(() => Effect.succeed(null))),
        errors,
      };
    });

  const serviceAction: VpsHost["Service"]["serviceAction"] = (input) =>
    Effect.gen(function* () {
      const unit = input.unit.trim();
      if (!config.units.includes(unit)) {
        return yield* new VpsHostError({
          operation: "serviceAction",
          detail: `${unit} is not a managed unit.`,
        });
      }
      // Stopping the unit that serves this UI leaves no way back in from the
      // browser; restart and start stay allowed so a wedged server is
      // recoverable from here.
      if (unit === config.selfUnit && input.action === "stop") {
        return yield* new VpsHostError({
          operation: "serviceAction",
          detail: `Refusing to stop ${unit}: it serves this app.`,
        });
      }

      const result = yield* runCommand("systemctl", [input.action, "--no-block", unit]);
      if (result.exitCode !== 0) {
        return yield* new VpsHostError({
          operation: "serviceAction",
          detail: result.stderr || `systemctl ${input.action} ${unit} failed.`,
        });
      }
      const service = yield* readService(unit).pipe(Effect.orElseSucceed(() => null));
      return { unit, action: input.action, service };
    });

  const signalProcess: VpsHost["Service"]["signalProcess"] = (input) =>
    Effect.gen(function* () {
      if (input.pid === process.pid || input.pid === 1) {
        return yield* new VpsHostError({
          operation: "signalProcess",
          detail:
            input.pid === 1
              ? "Refusing to signal init (pid 1)."
              : "Refusing to signal the T3J server process.",
        });
      }
      return yield* Effect.try({
        try: (): VpsSignalProcessResult => {
          process.kill(input.pid, input.signal);
          return { pid: input.pid, signal: input.signal, signaled: true, message: null };
        },
        catch: (cause) =>
          new VpsHostError({
            operation: "signalProcess",
            detail: `Failed to send ${input.signal} to ${input.pid}.`,
            cause,
          }),
      });
    });

  return VpsHost.of({ snapshot, runHealth, setForgeToken, serviceAction, signalProcess });
});

export const layer = Layer.effect(VpsHost, make);
