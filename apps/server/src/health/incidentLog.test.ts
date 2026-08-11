import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  bindHealthIncidentLog,
  countRecent,
  readHealthIncidents,
  recordHealthReport,
  unbindHealthIncidentLog,
} from "./incidentLog.ts";
import type { HealthReport } from "./types.ts";

const report = (at: string, status: "ok" | "warn" | "fail"): HealthReport => ({
  at,
  ok: status !== "fail",
  checks: [
    { id: "disk.headroom", title: "Disk", severity: "critical", status, detail: "0.5GiB free" },
    { id: "agent.cli", title: "CLIs", severity: "critical", status: "ok", detail: "claude" },
  ],
});

const withTempBase = <A>(use: (baseDir: string) => A): A => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "health-log-"));
  try {
    bindHealthIncidentLog(baseDir);
    return use(baseDir);
  } finally {
    unbindHealthIncidentLog();
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  }
};

describe("health incident log", () => {
  it("records only the non-ok outcomes", () => {
    withTempBase(() => {
      recordHealthReport(report("2026-01-01T00:00:00.000Z", "fail"));
      const incidents = readHealthIncidents(10);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]?.id).toBe("disk.headroom");
    });
  });

  it("writes nothing for a clean run", () => {
    withTempBase(() => {
      recordHealthReport(report("2026-01-01T00:00:00.000Z", "ok"));
      expect(readHealthIncidents(10)).toHaveLength(0);
    });
  });

  it("counts recurrences inside the window so a chronic failure is not news", () => {
    withTempBase(() => {
      recordHealthReport(report("2026-01-01T00:00:00.000Z", "fail"));
      recordHealthReport(report("2026-01-01T06:00:00.000Z", "warn"));
      recordHealthReport(report("2025-12-01T00:00:00.000Z", "fail"));
      const now = Date.parse("2026-01-01T12:00:00.000Z");
      expect(countRecent("disk.headroom", 24 * 60 * 60 * 1000, now)).toBe(2);
      expect(countRecent("agent.cli", 24 * 60 * 60 * 1000, now)).toBe(0);
    });
  });

  it("survives a torn line from a kill mid-write", () => {
    withTempBase((baseDir) => {
      recordHealthReport(report("2026-01-01T00:00:00.000Z", "fail"));
      NodeFS.appendFileSync(NodePath.join(baseDir, "health", "incidents.jsonl"), '{"id":"tor');
      expect(readHealthIncidents(10)).toHaveLength(1);
    });
  });

  it("is a no-op when no path is bound", () => {
    unbindHealthIncidentLog();
    recordHealthReport(report("2026-01-01T00:00:00.000Z", "fail"));
    expect(readHealthIncidents(10)).toHaveLength(0);
  });
});
