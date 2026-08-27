import { describe, expect, it } from "vite-plus/test";

import {
  countCompleteLines,
  parseInstallLog,
  parseInstallRun,
  runLogFileName,
} from "./installLog.ts";

const RUN = "20260725T120000Z-abcdef123456";

function event(phase: string, message: string, level = "info"): string {
  return JSON.stringify({ ts: "2026-07-25T12:00:00Z", level, phase, message });
}

describe("parseInstallLog", () => {
  it("assigns 1-based line numbers and carries the run id", () => {
    const text = `${event("build", "a")}\n${event("build", "b")}\n`;
    const events = parseInstallLog(text, RUN);
    expect(events.map((e) => e.line)).toEqual([1, 2]);
    expect(events.map((e) => e.message)).toEqual(["a", "b"]);
    expect(events[0]?.runId).toBe(RUN);
  });

  it("returns only lines strictly after fromLine, which is what resume needs", () => {
    const text = `${event("build", "a")}\n${event("build", "b")}\n${event("build", "c")}\n`;
    expect(parseInstallLog(text, RUN, 2).map((e) => e.message)).toEqual(["c"]);
    // Replaying from 0 is how a client recovers the whole run after the install
    // restarts the server out from under its socket.
    expect(parseInstallLog(text, RUN, 0)).toHaveLength(3);
    expect(parseInstallLog(text, RUN, 3)).toHaveLength(0);
  });

  it("skips a partial trailing line and picks it up once complete", () => {
    const whole = `${event("build", "a")}\n`;
    const partial = `${whole}{"ts":"2026-07`;
    expect(parseInstallLog(partial, RUN).map((e) => e.message)).toEqual(["a"]);

    const completed = `${whole}${event("build", "b")}\n`;
    expect(parseInstallLog(completed, RUN, 1).map((e) => e.message)).toEqual(["b"]);
  });

  it("keeps an unparseable line as raw text instead of aborting the tail", () => {
    const text = `not json\n${event("build", "b")}\n`;
    const events = parseInstallLog(text, RUN);
    expect(events).toHaveLength(2);
    expect(events[0]?.message).toBe("not json");
    expect(events[1]?.message).toBe("b");
  });

  it("defaults an unknown level rather than dropping the line", () => {
    const text = `${JSON.stringify({ level: "catastrophe", message: "x" })}\n`;
    expect(parseInstallLog(text, RUN)[0]?.level).toBe("info");
  });

  it("preserves error lines so a failure renders in the app", () => {
    const text = `${event("build", "boom", "error")}\n`;
    expect(parseInstallLog(text, RUN)[0]?.level).toBe("error");
  });

  it("handles an empty log", () => {
    expect(parseInstallLog("", RUN)).toEqual([]);
  });
});

describe("countCompleteLines", () => {
  it("counts only complete lines", () => {
    expect(countCompleteLines("")).toBe(0);
    expect(countCompleteLines("a\n")).toBe(1);
    expect(countCompleteLines("a\nb\n")).toBe(2);
    expect(countCompleteLines("a\nb")).toBe(1);
  });

  it("agrees with the last line number parseInstallLog emitted", () => {
    const text = `${event("build", "a")}\n${event("build", "b")}\n`;
    const events = parseInstallLog(text, RUN);
    expect(events[events.length - 1]?.line).toBe(countCompleteLines(text));
  });
});

describe("parseInstallRun", () => {
  it("parses a running pointer", () => {
    const run = parseInstallRun(
      JSON.stringify({
        runId: RUN,
        commit: "abc",
        phase: "build",
        status: "running",
        startedAt: "2026-07-25T12:00:00Z",
        finishedAt: null,
      }),
    );
    expect(run).toEqual({
      runId: RUN,
      commit: "abc",
      phase: "build",
      phaseLabel: null,
      status: "running",
      startedAt: "2026-07-25T12:00:00Z",
      finishedAt: null,
    });
  });

  it("carries the host's own phase label, so the app needs no map of steps", () => {
    const run = parseInstallRun(
      JSON.stringify({
        runId: RUN,
        status: "running",
        phase: "build",
        phaseLabel: "building release abc",
      }),
    );
    expect(run?.phaseLabel).toBe("building release abc");
  });

  it("treats a missing or empty phase label as absent rather than blank text", () => {
    expect(
      parseInstallRun(JSON.stringify({ runId: RUN, status: "running" }))?.phaseLabel,
    ).toBeNull();
    expect(
      parseInstallRun(JSON.stringify({ runId: RUN, status: "running", phaseLabel: "" }))
        ?.phaseLabel,
    ).toBeNull();
  });

  it("normalises an empty finishedAt to null", () => {
    const run = parseInstallRun(
      JSON.stringify({ runId: RUN, status: "completed", finishedAt: "" }),
    );
    expect(run?.finishedAt).toBeNull();
  });

  it("rejects unusable pointers instead of inventing a run", () => {
    expect(parseInstallRun("")).toBeNull();
    expect(parseInstallRun("{")).toBeNull();
    expect(parseInstallRun(JSON.stringify({ status: "running" }))).toBeNull();
    expect(parseInstallRun(JSON.stringify({ runId: RUN, status: "bogus" }))).toBeNull();
  });
});

describe("runLogFileName", () => {
  it("matches what deploy/lib/log.sh writes", () => {
    expect(runLogFileName(RUN)).toBe(`${RUN}.jsonl`);
  });
});
