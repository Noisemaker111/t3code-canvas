import { describe, expect, it } from "vite-plus/test";

import {
  analyzePerfSession,
  renderPerfReport,
  type PerfSample,
  type PerfSession,
} from "./perfSamples";

function session(samples: ReadonlyArray<PerfSample>, over: Partial<PerfSession> = {}): PerfSession {
  return {
    startedAt: "2026-08-03T10:00:00.000Z",
    durationMs: 10_000,
    frames: 400,
    agent: "TestAgent/1.0",
    cores: 8,
    notes: [],
    samples,
    ...over,
  };
}

function mount(target: string, ms: number, repeat: number): PerfSample {
  return { kind: "mount", at: repeat * 1_000, target, ms, repeat };
}

describe("analyzePerfSession", () => {
  it("says nothing about a session with one build per target", () => {
    expect(
      analyzePerfSession(session([mount("thread:a", 20, 0), mount("column:todo", 8, 0)])),
    ).toHaveLength(0);
  });

  it("names a rebuilt panel and totals the wasted work", () => {
    const findings = analyzePerfSession(
      session([mount("thread:a", 120, 0), mount("thread:a", 140, 1), mount("thread:a", 130, 2)]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe("churn:thread:a");
    expect(findings[0]!.title).toContain("rebuilt 2×");
    expect(findings[0]!.costMs).toBe(270);
    expect(findings[0]!.severity).toBe("high");
  });

  it("ranks worst first across kinds", () => {
    const findings = analyzePerfSession(
      session([
        mount("thread:a", 400, 0),
        mount("thread:a", 400, 1),
        { kind: "longtask", at: 500, target: "self", ms: 90 },
        { kind: "frame-gap", at: 600, target: "", ms: 80 },
      ]),
    );
    expect(findings.map((finding) => finding.id)).toEqual([
      "churn:thread:a",
      "frames",
      "longtasks",
    ]);
  });

  it("separates a slow first build from churn", () => {
    const findings = analyzePerfSession(session([mount("settings:vps", 320, 0)]));
    expect(findings[0]!.id).toBe("slow-mount:settings:vps");
    expect(findings[0]!.detail).toContain("first-open cost");
  });

  it("counts blocking time, not task time", () => {
    const findings = analyzePerfSession(
      session([
        { kind: "longtask", at: 10, target: "self", ms: 60 },
        { kind: "longtask", at: 20, target: "self", ms: 250 },
      ]),
    );
    expect(findings[0]!.costMs).toBe(210);
  });

  it("ignores interactions under the threshold", () => {
    expect(
      analyzePerfSession(session([{ kind: "interaction", at: 5, target: "pointerdown", ms: 120 }])),
    ).toHaveLength(0);
  });
});

describe("renderPerfReport", () => {
  it("leads with the ranked findings and carries the notes", () => {
    const report = renderPerfReport(
      session([mount("thread:a", 200, 0), mount("thread:a", 300, 1)], {
        notes: ["This browser does not report `longtask` — that column is missing, not zero."],
      }),
    );
    expect(report).toContain("# Performance report");
    expect(report).toContain("1. **🔴 high** — thread:a was torn down and rebuilt 1×");
    expect(report).toContain("- note: This browser does not report");
    expect(report).toContain("| t+ | kind | target | ms |");
  });

  it("says so plainly when nothing crossed a threshold", () => {
    expect(renderPerfReport(session([mount("thread:a", 12, 0)]))).toContain(
      "Nothing over threshold",
    );
  });
});
