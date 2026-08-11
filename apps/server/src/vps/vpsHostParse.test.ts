import { describe, expect, it } from "@effect/vitest";

import {
  buildProcessList,
  cpuPercentBetween,
  parseDf,
  upsertEnvKey,
  parseMeminfo,
  parseOsRelease,
  parseProcStatCpu,
  parsePsRows,
  parseSsListeners,
  parseSystemctlShow,
  parseSystemdBytes,
  parseSystemdTimestamp,
} from "./vpsHostParse.ts";

describe("parseMeminfo", () => {
  it("derives used memory from MemAvailable", () => {
    const memory = parseMeminfo(
      [
        "MemTotal:       4020000 kB",
        "MemFree:         200000 kB",
        "MemAvailable:   1020000 kB",
        "Buffers:          40000 kB",
        "Cached:          800000 kB",
        "SwapTotal:      1000000 kB",
        "SwapFree:        400000 kB",
      ].join("\n"),
    );
    expect(memory).not.toBeNull();
    expect(memory?.totalBytes).toBe(4_020_000 * 1024);
    expect(memory?.availableBytes).toBe(1_020_000 * 1024);
    expect(memory?.usedBytes).toBe(3_000_000 * 1024);
    expect(memory?.cachedBytes).toBe(840_000 * 1024);
    expect(memory?.swapUsedBytes).toBe(600_000 * 1024);
  });

  it("returns null without MemTotal", () => {
    expect(parseMeminfo("Bogus: 1 kB")).toBeNull();
  });
});

describe("parseProcStatCpu", () => {
  it("computes busy percent across two samples", () => {
    const first = parseProcStatCpu("cpu  100 0 100 800 0 0 0 0 0 0");
    const second = parseProcStatCpu("cpu  200 0 200 1600 0 0 0 0 0 0");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(cpuPercentBetween(first!, second!)).toBe(20);
  });

  it("returns null when the counters did not advance", () => {
    const sample = parseProcStatCpu("cpu  1 2 3 4 5");
    expect(cpuPercentBetween(sample!, sample!)).toBeNull();
  });
});

describe("parseDf", () => {
  const output = [
    "Filesystem     Type 1024-blocks     Used Available Capacity Mounted on",
    "/dev/vda1      ext4    41251136 20625568  20625568      50% /",
    "tmpfs          tmpfs     1000000     1000    999000       1% /run",
    "devtmpfs       devtmpfs   500000        0    500000       0% /dev",
    "/dev/vda15     vfat       100000     5000     95000       5% /boot/efi",
  ].join("\n");

  it("keeps real mounts and drops pseudo filesystems", () => {
    const rows = parseDf(output);
    expect(rows.map((row) => row.mountPoint)).toEqual(["/", "/run", "/boot/efi"]);
    expect(rows[0]?.totalBytes).toBe(41_251_136 * 1024);
    expect(rows[0]?.usePercent).toBe(50);
  });
});

describe("parseSystemctlShow", () => {
  it("splits on the first equals sign", () => {
    const values = parseSystemctlShow("Id=t3j.service\nDescription=T3J = the board\nMainPID=42");
    expect(values.Id).toBe("t3j.service");
    expect(values.Description).toBe("T3J = the board");
    expect(values.MainPID).toBe("42");
  });
});

describe("parseSystemdTimestamp", () => {
  it("reads microseconds since the epoch", () => {
    expect(parseSystemdTimestamp("1753600000000000")).toBe("2025-07-27T07:06:40.000Z");
  });

  it("reads @seconds", () => {
    expect(parseSystemdTimestamp("@1753600000")).toBe("2025-07-27T07:06:40.000Z");
  });

  it("reads the human form systemctl prints by default", () => {
    expect(parseSystemdTimestamp("Sun 2025-07-27 07:06:40 UTC")).toBe("2025-07-27T07:06:40.000Z");
  });

  it("treats never-run sentinels as absent", () => {
    expect(parseSystemdTimestamp("n/a")).toBeNull();
    expect(parseSystemdTimestamp("0")).toBeNull();
    expect(parseSystemdTimestamp(undefined)).toBeNull();
  });
});

describe("parseSystemdBytes", () => {
  it("rejects the unset sentinels", () => {
    expect(parseSystemdBytes("[not set]")).toBeNull();
    expect(parseSystemdBytes("18446744073709551615")).toBeNull();
    expect(parseSystemdBytes("1048576")).toBe(1_048_576);
  });
});

describe("parsePsRows / buildProcessList", () => {
  const output = [
    "    1     0 root      0.1  0.5   40960 10-01:02:03 /sbin/init",
    "  900     1 root      3.5  8.0 1048576 02:03:04 node /opt/t3j/current/dist/server.js",
    "  901   900 root     12.0  4.0  524288 01:00:00 cursor-agent --print",
    "  902     1 www-data  0.0  0.2   16384 05:00:00 nginx: worker process",
  ].join("\n");

  it("parses every field", () => {
    const rows = parsePsRows(output);
    expect(rows).toHaveLength(4);
    expect(rows[1]).toMatchObject({
      pid: 900,
      ppid: 1,
      user: "root",
      cpuPercent: 3.5,
      memPercent: 8,
      rssBytes: 1_048_576 * 1024,
      elapsed: "02:03:04",
    });
  });

  it("orders by CPU, marks the server tree and honours the limit", () => {
    const processes = buildProcessList(parsePsRows(output), 900, 2);
    expect(processes.map((entry) => entry.pid)).toEqual([901, 900]);
    expect(processes.every((entry) => entry.isServerTree)).toBe(true);
    expect(buildProcessList(parsePsRows(output), 900, 10)[3]?.isServerTree).toBe(false);
  });
});

describe("parseSsListeners", () => {
  it("splits address and port and picks up the owning process", () => {
    const listeners = parseSsListeners(
      [
        'tcp   LISTEN 0      511    0.0.0.0:80    0.0.0.0:*    users:(("nginx",pid=700,fd=6))',
        'tcp   LISTEN 0      511    [::]:443      [::]:*       users:(("nginx",pid=700,fd=7))',
        "udp   UNCONN 0      0      127.0.0.1:323 0.0.0.0:*",
        'tcp   ESTAB  0      0      10.0.0.1:22   10.0.0.2:5555 users:(("sshd",pid=800,fd=3))',
      ].join("\n"),
    );
    expect(listeners.map((entry) => entry.port)).toEqual([80, 323, 443]);
    expect(listeners[0]).toMatchObject({ address: "0.0.0.0", process: "nginx", pid: 700 });
    expect(listeners[2]?.address).toBe("[::]");
  });
});

describe("parseOsRelease", () => {
  it("unquotes values", () => {
    expect(parseOsRelease('PRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu').PRETTY_NAME).toBe(
      "Ubuntu 24.04.1 LTS",
    );
  });
});

describe("upsertEnvKey", () => {
  it("replaces the key in place, leaving every other line alone", () => {
    const before = "# comment\nT3_TOKEN=abc\nGH_TOKEN=old\nPATH=/usr/bin\n";
    expect(upsertEnvKey(before, "GH_TOKEN", "new")).toBe(
      "# comment\nT3_TOKEN=abc\nGH_TOKEN=new\nPATH=/usr/bin\n",
    );
  });

  it("appends when the key is absent, with one trailing newline", () => {
    expect(upsertEnvKey("T3_TOKEN=abc\n", "GH_TOKEN", "ghp_x")).toBe(
      "T3_TOKEN=abc\nGH_TOKEN=ghp_x\n",
    );
    expect(upsertEnvKey("", "GH_TOKEN", "ghp_x")).toBe("GH_TOKEN=ghp_x\n");
  });

  it("clears the value without dropping the key", () => {
    expect(upsertEnvKey("GH_TOKEN=old\n", "GH_TOKEN", "")).toBe("GH_TOKEN=\n");
  });

  it("does not match a key that only shares a prefix", () => {
    expect(upsertEnvKey("GH_TOKEN_EXTRA=keep\n", "GH_TOKEN", "x")).toBe(
      "GH_TOKEN_EXTRA=keep\nGH_TOKEN=x\n",
    );
  });
});
