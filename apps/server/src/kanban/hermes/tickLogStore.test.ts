import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { HermesTickTranscript } from "@t3tools/contracts";

import {
  appendHermesTick,
  bindHermesTickLog,
  readHermesTickLog,
  unbindHermesTickLog,
} from "./tickLogStore.ts";

const tick = (id: string, overrides: Partial<HermesTickTranscript> = {}): HermesTickTranscript => ({
  id,
  ranAt: "2026-01-01T00:00:00.000Z",
  durationMs: 12,
  tier: "cursor",
  model: "x-ai/grok-4.5",
  attempts: [],
  program: "await board.list();",
  calls: [],
  logs: [],
  summary: `${id} summary`,
  error: null,
  recordOnly: false,
  ...overrides,
});

const withTempBase = <A>(use: (baseDir: string) => A): A => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hermes-log-"));
  try {
    bindHermesTickLog(baseDir);
    return use(baseDir);
  } finally {
    unbindHermesTickLog();
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  }
};

describe("hermes tick log store", () => {
  it("round-trips ticks through the file so a restart keeps the log", () => {
    withTempBase(() => {
      appendHermesTick(tick("tick-1"), 30);
      appendHermesTick(tick("tick-2"), 30);

      expect(readHermesTickLog(30).map((entry) => entry.id)).toEqual(["tick-1", "tick-2"]);
    });
  });

  it("keeps only the newest ticks up to the limit", () => {
    withTempBase(() => {
      for (let index = 1; index <= 5; index += 1) appendHermesTick(tick(`tick-${index}`), 3);

      expect(readHermesTickLog(30).map((entry) => entry.id)).toEqual([
        "tick-3",
        "tick-4",
        "tick-5",
      ]);
    });
  });

  it("truncates an oversized program instead of writing a huge line", () => {
    withTempBase(() => {
      appendHermesTick(tick("tick-1", { program: "x".repeat(40_000) }), 30);

      const stored = readHermesTickLog(1)[0];
      expect(stored?.program?.length).toBeLessThan(5_000);
      expect(stored?.program?.endsWith("…")).toBe(true);
    });
  });

  it("survives a torn line from a kill mid-write", () => {
    withTempBase((baseDir) => {
      appendHermesTick(tick("tick-1"), 30);
      NodeFS.appendFileSync(NodePath.join(baseDir, "hermes", "ticks.jsonl"), '{"id":"tick-2"');

      expect(readHermesTickLog(30).map((entry) => entry.id)).toEqual(["tick-1"]);
    });
  });

  it("is a no-op when no base directory is bound", () => {
    unbindHermesTickLog();
    appendHermesTick(tick("tick-1"), 30);
    expect(readHermesTickLog(30)).toEqual([]);
  });
});
