import { describe, expect, it } from "@effect/vitest";

import { retryFreshAcpOpen } from "./acpBackends.ts";

describe("Hermes ACP open recovery", () => {
  it("backs off and retries a timed-out fresh open without invoking an agent binary", async () => {
    let opens = 0;
    let backoffs = 0;

    const session = await retryFreshAcpOpen({
      timeoutLabel: "test ACP request",
      open: async () => {
        opens += 1;
        return opens === 1 ? null : { sessionId: "fresh-session" };
      },
      backoff: async () => {
        backoffs += 1;
      },
    });

    expect(opens).toBe(2);
    expect(backoffs).toBe(1);
    expect(session.sessionId).toBe("fresh-session");
  });

  it("leaves a timed-out resume to the session owner instead of retrying stale state", async () => {
    let opens = 0;
    let backoffs = 0;

    await expect(
      retryFreshAcpOpen({
        resumeSessionId: "stale-session",
        timeoutLabel: "test ACP request",
        open: async () => {
          opens += 1;
          return null;
        },
        backoff: async () => {
          backoffs += 1;
        },
      }),
    ).rejects.toThrow("test ACP request open timed out");
    expect(opens).toBe(1);
    expect(backoffs).toBe(0);
  });
});
