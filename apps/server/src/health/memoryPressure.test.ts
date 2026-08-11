import { describe, expect, it } from "@effect/vitest";

import { evaluateMemoryPressure } from "./memoryPressure.ts";

const meminfo = (availableKb: number, totalKb = 7_929_000, swapUsedKb = 0): string =>
  [
    `MemTotal:       ${totalKb} kB`,
    `MemFree:        ${availableKb} kB`,
    `MemAvailable:   ${availableKb} kB`,
    "Buffers:              0 kB",
    "Cached:               0 kB",
    "SwapTotal:      4194300 kB",
    `SwapFree:       ${4_194_300 - swapUsedKb} kB`,
  ].join("\n");

describe("evaluateMemoryPressure", () => {
  it("reports no pressure with room to spare", () => {
    expect(evaluateMemoryPressure(meminfo(6_000_000)).low).toBe(false);
  });

  it("reports pressure below the floor, naming the numbers", () => {
    const pressure = evaluateMemoryPressure(meminfo(200_000, 7_929_000, 3_500_000));
    expect(pressure.low).toBe(true);
    expect(pressure.detail).toContain("195MiB available of 7743MiB");
    expect(pressure.detail).toContain("swap 3418MiB used");
  });

  // The box this protects is the VPS. A dev machine with no procfs must not
  // have its provider probes silently disabled.
  it("reports no pressure when /proc/meminfo is unreadable", () => {
    expect(evaluateMemoryPressure(null)).toEqual({ low: false, detail: null });
  });

  it("reports no pressure when the file is unparseable", () => {
    expect(evaluateMemoryPressure("garbage").low).toBe(false);
  });
});
