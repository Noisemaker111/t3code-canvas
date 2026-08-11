import { describe, expect, it } from "vite-plus/test";

import {
  createUsageRefreshController,
  initialUsageFetchState,
  type UsageFetchState,
} from "./UsageIndicator.logic";

const okBody = JSON.stringify({ providers: { codex: { displayName: "Codex" } }, errors: [] });
const okResponse = () => new Response(okBody, { status: 200 });

function collect() {
  const states: UsageFetchState[] = [];
  return { states, onChange: (state: UsageFetchState) => states.push(state) };
}

describe("createUsageRefreshController", () => {
  it("loads usage and reports a success timestamp", async () => {
    const { states, onChange } = collect();
    const controller = createUsageRefreshController({
      onChange,
      fetchImpl: async () => okResponse(),
      retryDelaysMs: [0],
      now: () => Date.parse("2026-07-22T12:00:00Z"),
    });
    await controller.refresh();
    const last = states.at(-1)!;
    expect(last.isRefreshing).toBe(false);
    expect(last.error).toBeNull();
    expect(last.data?.providers?.codex?.displayName).toBe("Codex");
    expect(last.lastSuccessAt).toBe("2026-07-22T12:00:00.000Z");
  });

  it("never leaves the spinner stuck when the fetch hangs forever (the production bug)", async () => {
    const { states, onChange } = collect();
    const controller = createUsageRefreshController({
      onChange,
      // A fetch that never settles and ignores its abort signal — worst case: a stalled
      // Cloudflare tunnel plus a transport that doesn't honor aborts.
      fetchImpl: () => new Promise<Response>(() => {}),
      attemptTimeoutMs: 20,
      retryDelaysMs: [0],
    });
    await controller.refresh();
    const last = states.at(-1)!;
    expect(last.isRefreshing).toBe(false);
    expect(last.error).toMatch(/timed out/u);
    expect(last.failedAttempts).toBe(1);
    controller.dispose();
  });

  it("retries 5xx responses and succeeds within the same cycle", async () => {
    const { states, onChange } = collect();
    let calls = 0;
    const controller = createUsageRefreshController({
      onChange,
      fetchImpl: async () => {
        calls += 1;
        return calls < 3 ? new Response("bad gateway", { status: 502 }) : okResponse();
      },
      retryDelaysMs: [0, 1, 1],
      attemptTimeoutMs: 100,
    });
    await controller.refresh();
    const last = states.at(-1)!;
    expect(calls).toBe(3);
    expect(last.error).toBeNull();
    expect(last.data).not.toBeNull();
  });

  it("surfaces 4xx immediately without burning retries", async () => {
    const { states, onChange } = collect();
    let calls = 0;
    const controller = createUsageRefreshController({
      onChange,
      fetchImpl: async () => {
        calls += 1;
        return new Response("nope", { status: 401 });
      },
      retryDelaysMs: [0, 1, 1],
      attemptTimeoutMs: 100,
    });
    await controller.refresh();
    expect(calls).toBe(1);
    expect(states.at(-1)!.error).toBe("Usage endpoint returned 401");
    expect(states.at(-1)!.isRefreshing).toBe(false);
  });

  it("keeps last-known-good data when a later refresh fails", async () => {
    const { states, onChange } = collect();
    let fail = false;
    const controller = createUsageRefreshController({
      onChange,
      fetchImpl: async () => (fail ? new Response("down", { status: 503 }) : okResponse()),
      retryDelaysMs: [0],
      attemptTimeoutMs: 100,
    });
    await controller.refresh();
    fail = true;
    await controller.refresh();
    const last = states.at(-1)!;
    expect(last.data?.providers?.codex).toBeDefined();
    expect(last.error).toBe("Usage endpoint returned 503");
    expect(last.failedAttempts).toBe(1);
  });

  it("lets a force refresh supersede a hung cycle and still succeed", async () => {
    const { states, onChange } = collect();
    let calls = 0;
    const controller = createUsageRefreshController({
      onChange,
      fetchImpl: (url) => {
        calls += 1;
        if (calls === 1) return new Promise<Response>(() => {}); // hung background refresh
        expect(url).toContain("force=1");
        return Promise.resolve(okResponse());
      },
      attemptTimeoutMs: 5_000,
      retryDelaysMs: [0],
    });
    const background = controller.refresh();
    const forced = controller.refresh(true);
    await Promise.all([background, forced]);
    const last = states.at(-1)!;
    expect(last.data).not.toBeNull();
    expect(last.error).toBeNull();
    expect(last.isRefreshing).toBe(false);
    controller.dispose();
  });

  it("ignores non-forced refreshes while one is already in flight", async () => {
    const { onChange } = collect();
    let calls = 0;
    let release: (r: Response) => void = () => {};
    const controller = createUsageRefreshController({
      onChange,
      fetchImpl: () => {
        calls += 1;
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      },
      attemptTimeoutMs: 5_000,
      retryDelaysMs: [0],
    });
    const first = controller.refresh();
    const second = controller.refresh();
    release(okResponse());
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });

  it("a late response from a superseded cycle cannot clobber newer state", async () => {
    const { states, onChange } = collect();
    let calls = 0;
    let releaseFirst: (r: Response) => void = () => {};
    const controller = createUsageRefreshController({
      onChange,
      fetchImpl: () => {
        calls += 1;
        if (calls === 1)
          return new Promise<Response>((resolve) => {
            releaseFirst = resolve;
          });
        return Promise.resolve(okResponse());
      },
      attemptTimeoutMs: 5_000,
      retryDelaysMs: [0],
    });
    const first = controller.refresh();
    const second = controller.refresh(true);
    await second;
    const settledState = states.at(-1)!;
    // The first cycle's fetch finally answers with garbage — it must be discarded.
    releaseFirst(new Response("stale junk", { status: 500 }));
    await first;
    expect(states.at(-1)).toBe(settledState);
    expect(controller.state.error).toBeNull();
    expect(controller.state.data).not.toBeNull();
  });

  it("dispose aborts an in-flight cycle without writing state afterwards", async () => {
    const { states, onChange } = collect();
    const controller = createUsageRefreshController({
      onChange,
      fetchImpl: () => new Promise<Response>(() => {}),
      attemptTimeoutMs: 5_000,
      retryDelaysMs: [0],
    });
    const pending = controller.refresh();
    controller.dispose();
    await pending;
    const writesAfterDispose = states.filter(
      (state) => state !== states[0] && state.error !== null,
    );
    expect(writesAfterDispose).toHaveLength(0);
  });

  it("starts from a clean initial state", () => {
    expect(initialUsageFetchState).toEqual({
      data: null,
      error: null,
      isRefreshing: false,
      lastSuccessAt: null,
      failedAttempts: 0,
    });
  });
});
