import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { reconcileStickyData, type StickyData } from "./stickyData";

const ENV = "env-1" as EnvironmentId;
const LOADED: StickyData<{ document: string }> = {
  environmentId: ENV,
  data: { document: "hello" },
};

describe("reconcileStickyData", () => {
  it("holds the last payload while the same environment refetches", () => {
    // A reconnect gap hands the query `null` (waiting, no value). Bridge it.
    expect(reconcileStickyData(LOADED, ENV, null)).toBe(LOADED);
  });

  it("takes a successful empty-ish payload over the stale one", () => {
    const next = reconcileStickyData(LOADED, ENV, { document: null as unknown as string });
    expect(next.data).toEqual({ document: null });
  });

  it("replaces with a real new payload", () => {
    const next = reconcileStickyData(LOADED, ENV, { document: "world" });
    expect(next.data).toEqual({ document: "world" });
  });

  it("drops the sticky payload when the environment changes", () => {
    const next = reconcileStickyData(LOADED, "env-2" as EnvironmentId, null);
    expect(next.data).toBeNull();
    expect(next.environmentId).toBe("env-2");
  });

  it("clears when the environment becomes null", () => {
    const next = reconcileStickyData(LOADED, null, null);
    expect(next).toEqual({ environmentId: null, data: null });
  });
});
