import { describe, expect, it } from "@effect/vitest";

import {
  commandFamily,
  detectFriction,
  detectWorkarounds,
  type FrictionActivityRow,
} from "./detector.ts";

const row = (over: Partial<FrictionActivityRow> = {}): FrictionActivityRow => ({
  threadId: "thread-1",
  kind: "tool.completed",
  tone: "tool",
  summary: "apply_patch",
  detail: "failed to apply hunk at line 42",
  createdAt: "2026-07-28T00:00:00.000Z",
  ...over,
});

describe("friction detector", () => {
  it("files a failure that happened once", () => {
    const found = detectFriction([row()]);
    expect(found).toHaveLength(1);
    expect(found[0]?.tool).toBe("apply_patch");
    expect(found[0]?.source).toBe("detector");
    expect(found[0]?.threadId).toBe("thread-1");
  });

  it("collapses repeats of one signature into one papercut with a count", () => {
    const found = detectFriction([
      row(),
      row({ detail: "failed to apply hunk at line 91" }),
      row({ detail: "failed to apply hunk at line 7" }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.context?.detectedRepeats).toBe("3");
  });

  it("does not merge repeats across different threads", () => {
    const found = detectFriction([
      row({ threadId: "a" }),
      row({ threadId: "a" }),
      row({ threadId: "b" }),
    ]);
    expect(found).toHaveLength(2);
  });

  it("keeps two different failures of one tool apart", () => {
    const found = detectFriction([row(), row({ detail: "permission denied" })]);
    expect(found).toHaveLength(2);
    expect(found[0]?.evidence).toContain("hunk");
    expect(found[1]?.evidence).toContain("denied");
  });

  it("skips a successful tool call", () => {
    const ok = row({ detail: "applied 3 hunks" });
    expect(detectFriction([ok, ok, ok])).toHaveLength(0);
  });

  it("catches error-toned activities regardless of their text", () => {
    const err = row({
      kind: "runtime.error",
      tone: "error",
      summary: "Runtime error",
      detail: "stream closed",
    });
    const found = detectFriction([err, err, err]);
    expect(found).toHaveLength(1);
    expect(found[0]?.tool).toBe("runtime");
  });

  it("names the tool a denial was about", () => {
    const denied = row({
      kind: "tool.denied",
      tone: "error",
      summary: "Tool denied: write_file",
      detail: "not permitted",
    });
    const found = detectFriction([denied, denied, denied]);
    expect(found[0]?.tool).toBe("write_file");
  });

  it("takes the tool from the first token of a titled activity", () => {
    const titled = row({
      summary: "Edit file src/app.ts",
      detail: "error: file is read-only",
    });
    const found = detectFriction([titled, titled, titled]);
    expect(found[0]?.tool).toBe("Edit");
  });

  it("counts a harness-reported failed status without matching on words", () => {
    const failed = row({
      kind: "tool.updated",
      tone: "tool",
      status: "failed",
      summary: "Command run",
      detail: "exited 1",
    });
    expect(detectFriction([failed, failed, failed])).toHaveLength(1);
  });

  it("leaves shell commands to the workaround detector", () => {
    // A grep that matched nothing exits non-zero and is never retried. Reported
    // here it became a papercut named after the activity title's first word.
    const searched = row({
      kind: "tool.updated",
      status: "failed",
      itemType: "command_execution",
      summary: "Ran command",
      detail: null,
      command: "rg -n hotbar /var/lib/t3j/hermes/chat.jsonl | head -20",
    });
    expect(detectFriction([searched])).toHaveLength(0);
  });

  it("still files a non-command failure that no agent reported", () => {
    // The command carve-out must not cost the cases this pass exists for:
    // a harness-internal failure has no command to substitute, so the
    // workaround detector can never see it.
    const checkpoint = row({
      kind: "tool.updated",
      status: "failed",
      summary: "Checkpoint capture failed",
      detail: "VCS process timed out in GitVcsDriver.captureCheckpoint after 30000ms",
    });
    const found = detectFriction([checkpoint]);
    expect(found).toHaveLength(1);
    expect(found[0]?.tool).toBe("Checkpoint");
  });

  it("files a command failure only once, under its real family", () => {
    // Both passes used to fire on the same row: `Command` from the title here,
    // `git show` from the command there — one failure, two fingerprints.
    const rows = [
      failedAt("cd vendor/t3code && git show --stat eaf117b", "2026-07-28T00:00:00.000Z"),
      okAt("git show --stat eaf117b", "2026-07-28T00:01:00.000Z"),
    ];
    expect(detectFriction(rows)).toHaveLength(0);
    const worked = detectWorkarounds(rows);
    expect(worked).toHaveLength(1);
    expect(worked[0]?.tool).toBe("git show");
  });

  it("files a clear harness papercut for a missing repository-mandated skill", () => {
    const missing = row({
      kind: "runtime.error",
      tone: "error",
      summary: "Provider session failed",
      detail: "The repository-mandated test-t3-app skill is not installed in this session.",
    });
    const found = detectFriction([missing]);
    expect(found).toMatchObject([
      {
        scope: "harness",
        tool: "repository-mandated-skills",
        summary: "Repository-mandated skill 'test-t3-app' is missing",
        evidence: expect.stringContaining("test-t3-app"),
      },
    ]);
  });
});

const cmd = (over: Partial<FrictionActivityRow> = {}): FrictionActivityRow => ({
  threadId: "thread-1",
  kind: "tool.updated",
  tone: "tool",
  itemType: "command_execution",
  summary: "Command run",
  detail: null,
  createdAt: "2026-07-28T00:00:00.000Z",
  ...over,
});

const failedAt = (command: string, at: string, over: Partial<FrictionActivityRow> = {}) =>
  cmd({ command, createdAt: at, status: "failed", ...over });

const okAt = (command: string, at: string, over: Partial<FrictionActivityRow> = {}) =>
  cmd({ command, createdAt: at, kind: "tool.completed", status: null, ...over });

describe("commandFamily", () => {
  it("strips the directory, env and flags an agent bolted on", () => {
    expect(commandFamily("cd /home/user/vps-code && vp lint --report-unused")).toBe("vp lint");
    expect(commandFamily("CI=1 timeout 300 vp lint")).toBe("vp lint");
  });

  it("keeps a runner's subcommand, which is the tool an agent means", () => {
    expect(commandFamily("vp test run --project unit")).toBe("vp test run");
    expect(commandFamily("pnpm run typecheck")).toBe("pnpm run typecheck");
  });
});

describe("workaround detector", () => {
  it("files a papercut for a command that failed once and was substituted", () => {
    const found = detectWorkarounds([
      failedAt("vp lint", "2026-07-28T00:00:00.000Z", {
        detail: 'error: Package not found in workspace: AbsolutePathBuf("/home/user/vps-code")',
      }),
      okAt("cd vendor/t3code && vp lint", "2026-07-28T00:01:00.000Z"),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.tool).toBe("vp lint");
    expect(found[0]?.workaround).toBe("cd vendor/t3code && vp lint");
    expect(found[0]?.context?.["failedCommand"]).toBe("vp lint");
  });

  it("stays quiet for a one-off failure nothing replaced", () => {
    expect(
      detectWorkarounds([
        failedAt("grep missing src", "2026-07-28T00:00:00.000Z"),
        okAt("vp lint", "2026-07-28T00:01:00.000Z"),
      ]),
    ).toHaveLength(0);
  });

  it("stays quiet when the same command is retried and works", () => {
    expect(
      detectWorkarounds([
        failedAt("vp lint", "2026-07-28T00:00:00.000Z"),
        okAt("vp lint", "2026-07-28T00:01:00.000Z"),
      ]),
    ).toHaveLength(0);
  });

  it("ignores a substitute that ran before the failure", () => {
    expect(
      detectWorkarounds([
        okAt("cd vendor/t3code && vp lint", "2026-07-28T00:00:00.000Z"),
        failedAt("vp lint", "2026-07-28T00:01:00.000Z"),
      ]),
    ).toHaveLength(0);
  });

  it("does not pair a substitute from another family", () => {
    expect(
      detectWorkarounds([
        failedAt("vp lint", "2026-07-28T00:00:00.000Z"),
        okAt("vp test run", "2026-07-28T00:01:00.000Z"),
      ]),
    ).toHaveLength(0);
  });

  it("reports one papercut however many times the agent retried it", () => {
    const found = detectWorkarounds([
      failedAt("vp lint", "2026-07-28T00:00:00.000Z"),
      failedAt("vp lint", "2026-07-28T00:01:00.000Z"),
      okAt("cd vendor/t3code && vp lint", "2026-07-28T00:02:00.000Z"),
    ]);
    expect(found).toHaveLength(1);
  });

  it("keeps threads apart", () => {
    expect(
      detectWorkarounds([
        failedAt("vp lint", "2026-07-28T00:00:00.000Z", { threadId: "a" }),
        okAt("cd vendor/t3code && vp lint", "2026-07-28T00:01:00.000Z", { threadId: "b" }),
      ]),
    ).toHaveLength(0);
  });

  it("skips tool calls that carry no command", () => {
    expect(
      detectWorkarounds([
        cmd({ command: null, status: "failed" }),
        okAt("vp lint", "2026-07-28T00:01:00.000Z"),
      ]),
    ).toHaveLength(0);
  });
});
