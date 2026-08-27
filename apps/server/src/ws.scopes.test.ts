import { describe, expect, it } from "@effect/vitest";
import { WsRpcGroup } from "@t3tools/contracts";

import { RPC_REQUIRED_SCOPE } from "./ws.ts";

/**
 * A method with no scope throws at call time, not at boot, so the gap reaches
 * production as a dead button. `vps.setForgeToken` shipped that way once.
 */
describe("RPC_REQUIRED_SCOPE", () => {
  it("covers every RPC the server serves", () => {
    const served = [...WsRpcGroup.requests.keys()];
    expect(served.length).toBeGreaterThan(0);
    expect(served.filter((tag) => !RPC_REQUIRED_SCOPE.has(tag))).toEqual([]);
  });
});
