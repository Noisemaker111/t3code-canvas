import { describe, expect, it } from "@effect/vitest";

import { parseLoad1, parseNproc, verdictFromLoadAverage } from "./hostLoad.ts";

describe("verdictFromLoadAverage", () => {
  it("passes modest load", () => {
    expect(verdictFromLoadAverage({ load1: 1.2, nproc: 4 }).status).toBe("ok");
  });

  it("warns when load is 1.5× cores", () => {
    const v = verdictFromLoadAverage({ load1: 6.5, nproc: 4 });
    expect(v.status).toBe("warn");
    expect(v.detail).toContain("elevated");
  });

  it("fails when load is 3× cores", () => {
    const v = verdictFromLoadAverage({ load1: 14, nproc: 4 });
    expect(v.status).toBe("fail");
    expect(v.detail).toContain("thrashing");
  });
});

describe("parseLoad1 / parseNproc", () => {
  it("parses /proc/loadavg", () => {
    expect(parseLoad1("7.49 8.53 9.25 2/800 1")).toBeCloseTo(7.49);
  });

  it("parses uptime text", () => {
    expect(parseLoad1(" 18:38:04 up 6 days,  load average: 7.49, 8.53, 9.25")).toBeCloseTo(7.49);
  });

  it("parses nproc", () => {
    expect(parseNproc("4\n")).toBe(4);
  });
});
