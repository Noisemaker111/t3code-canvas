import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  PreviewTabId,
  ThreadId,
  type AgentBrowserAttachStreamEvent,
  type AgentBrowserSessionsStreamEvent,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import type * as Pw from "playwright-core";
import { expect } from "vite-plus/test";

import * as AgentBrowserManager from "./Manager.ts";
import { normalizeAgentBrowserUrl } from "./Manager.ts";

class WaitForConditionError extends Data.TaggedError("WaitForConditionError")<{
  readonly message: string;
}> {}

const waitFor = (message: string, condition: () => boolean) =>
  Effect.suspend(() =>
    condition() ? Effect.void : Effect.fail(new WaitForConditionError({ message })),
  ).pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 300 }));

class FakeCdpSession {
  readonly sent: Array<{ method: string; params: unknown }> = [];
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  on(event: string, callback: (payload: unknown) => void): void {
    const existing = this.listeners.get(event) ?? new Set();
    existing.add(callback);
    this.listeners.set(event, existing);
  }

  async send(method: string, params?: unknown): Promise<unknown> {
    this.sent.push({ method, params });
    return {};
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  sentMethods(): ReadonlyArray<string> {
    return this.sent.map((entry) => entry.method);
  }
}

class FakePage {
  url = "about:blank";
  closed = false;
  pageTitle = "";
  viewport = { width: 1280, height: 800 };
  readonly gotoCalls: Array<string> = [];
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  private readonly frame = { url: () => this.url };

  on(event: string, callback: (payload: unknown) => void): void {
    const existing = this.listeners.get(event) ?? new Set();
    existing.add(callback);
    this.listeners.set(event, existing);
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  mainFrame(): unknown {
    return this.frame;
  }

  async goto(url: string): Promise<null> {
    this.url = url;
    this.gotoCalls.push(url);
    this.emit("framenavigated", this.frame);
    return null;
  }

  async title(): Promise<string> {
    return this.pageTitle;
  }

  async setViewportSize(size: { width: number; height: number }): Promise<void> {
    this.viewport = size;
  }

  async goBack(): Promise<null> {
    return null;
  }

  async goForward(): Promise<null> {
    return null;
  }

  async reload(): Promise<null> {
    return null;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.emit("close", undefined);
  }
}

/** The one persistent profile every tab lives in. */
class FakeProfile {
  readonly openedPages: Array<FakePage> = [];
  readonly cdp = new FakeCdpSession();
  closed = false;

  pages(): ReadonlyArray<unknown> {
    return this.openedPages;
  }

  async newPage(): Promise<unknown> {
    const page = new FakePage();
    this.openedPages.push(page);
    return page;
  }

  async newCDPSession(_page: unknown): Promise<unknown> {
    return this.cdp;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const page of this.openedPages) page.emit("close", undefined);
  }
}

const threadId = ThreadId.make("thread-browser-1");
const tabId = PreviewTabId.make("tab-1");

const createManager = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-browser-" });
  const executable = join(baseDir, "chromium");
  yield* fs.writeFileString(executable, "#!/bin/sh\n");
  const profilesRoot = join(baseDir, "browser-profiles");
  const opened = new Map<string, FakeProfile>();
  const launched: Array<string> = [];
  const manager = yield* AgentBrowserManager.makeWithOptions({
    env: { T3CODE_BROWSER_EXECUTABLE: executable },
    profileDir: profilesRoot,
    launch: async (_executablePath, dir) => {
      launched.push(dir);
      const created = new FakeProfile();
      opened.set(dir, created);
      return created as unknown as Pw.BrowserContext;
    },
  });
  const profileAt = (name: string) => opened.get(join(profilesRoot, name))!;
  const dirFor = (name: string) => join(profilesRoot, name);
  return { manager, profileAt, dirFor, launched };
});

it.layer(NodeServices.layer, { excludeTestServices: true })("AgentBrowserManager", (it) => {
  it.effect("opens one session per tab and reuses the thread's latest tab", () =>
    Effect.gen(function* () {
      const { manager, profileAt, dirFor, launched } = yield* createManager();
      const first = yield* manager.open({ threadId, tabId, url: "example.com" });
      const second = yield* manager.open({ threadId });
      const profile = profileAt("default");

      assert.equal(first.tabId, tabId);
      assert.equal(second.tabId, tabId);
      // One page for one tab, in the one profile — the cookie jar every tab
      // shares, at the directory the server owns.
      expect(profile.openedPages).toHaveLength(1);
      expect(launched).toEqual([dirFor("default")]);
      expect(profile.openedPages[0]?.gotoCalls).toEqual(["https://example.com"]);
    }),
  );

  // Two jars at once is the point: a tab names its profile, the box starts one
  // Chromium per name, and a tab never moves between them.
  it.effect("runs a tab per cookie jar, side by side", () =>
    Effect.gen(function* () {
      const { manager, profileAt, dirFor, launched } = yield* createManager();
      const plain = yield* manager.open({ threadId, tabId, url: "example.com" });
      const other = yield* manager.open({ threadId, profile: "Staging " });

      assert.equal(plain.profile, "default");
      assert.equal(other.profile, "staging");
      assert.notEqual(plain.tabId, other.tabId);
      expect(launched).toEqual([dirFor("default"), dirFor("staging")]);
      expect(profileAt("default").openedPages).toHaveLength(1);
      expect(profileAt("staging").openedPages).toHaveLength(1);
      expect(yield* manager.listProfiles()).toEqual(["default", "staging"]);
    }),
  );

  it.effect("fails loudly when no chromium executable is configured", () =>
    Effect.gen(function* () {
      const manager = yield* AgentBrowserManager.makeWithOptions({
        env: {},
        probeLocations: { browsersDirs: [], executables: [] },
      });
      const result = yield* Effect.flip(manager.open({ threadId }));
      assert.equal(result._tag, "AgentBrowserUnavailableError");
    }),
  );

  it.effect("screencasts only while a viewer is attached and fans frames out", () =>
    Effect.gen(function* () {
      const { manager, profileAt } = yield* createManager();
      yield* manager.open({ threadId, tabId });
      const context = profileAt("default");

      const events: Array<AgentBrowserAttachStreamEvent> = [];
      const unsubscribe = yield* manager.attachStream({ threadId, tabId }, (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      );

      assert.equal(events[0]?.type, "status");
      yield* waitFor("screencast started", () =>
        context.cdp.sentMethods().includes("Page.startScreencast"),
      );

      context.cdp.emit("Page.screencastFrame", {
        data: "anNwZWc=",
        sessionId: 7,
        metadata: { deviceWidth: 1280, deviceHeight: 800 },
      });
      yield* waitFor("frame delivered", () => events.some((event) => event.type === "frame"));
      yield* waitFor("frame acked", () =>
        context.cdp.sentMethods().includes("Page.screencastFrameAck"),
      );

      unsubscribe();
      yield* waitFor("screencast stopped", () =>
        context.cdp.sentMethods().includes("Page.stopScreencast"),
      );
    }),
  );

  it.effect("forwards human input events over CDP", () =>
    Effect.gen(function* () {
      const { manager, profileAt } = yield* createManager();
      yield* manager.open({ threadId, tabId });
      const cdp = profileAt("default").cdp;

      yield* manager.dispatchInput({
        threadId,
        tabId,
        event: { kind: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 },
      });
      yield* manager.dispatchInput({ threadId, tabId, event: { kind: "char", text: "h" } });
      yield* manager.dispatchInput({
        threadId,
        tabId,
        event: { kind: "keyDown", key: "Enter", code: "Enter" },
      });

      const methods = cdp.sentMethods();
      assert.isTrue(methods.includes("Input.dispatchMouseEvent"));
      assert.isTrue(methods.includes("Input.insertText"));
      assert.isTrue(methods.includes("Input.dispatchKeyEvent"));
      const keyEvent = cdp.sent.find((entry) => entry.method === "Input.dispatchKeyEvent");
      expect(keyEvent?.params).toMatchObject({ windowsVirtualKeyCode: 13 });
    }),
  );

  it.effect("close removes the session from the roster and notifies viewers", () =>
    Effect.gen(function* () {
      const { manager, profileAt } = yield* createManager();

      const rosterEvents: Array<AgentBrowserSessionsStreamEvent> = [];
      const unsubscribeRoster = yield* manager.subscribeSessions((event) =>
        Effect.sync(() => {
          rosterEvents.push(event);
        }),
      );

      yield* manager.open({ threadId, tabId });
      const attachEvents: Array<AgentBrowserAttachStreamEvent> = [];
      yield* manager.attachStream({ threadId, tabId }, (event) =>
        Effect.sync(() => {
          attachEvents.push(event);
        }),
      );

      yield* manager.close({ threadId, tabId });
      yield* waitFor("roster remove", () => rosterEvents.some((event) => event.type === "remove"));
      yield* waitFor("viewer closed", () => attachEvents.some((event) => event.type === "closed"));
      // The tab's page closes; the profile — every cookie the box holds — does
      // not go with it.
      const profile = profileAt("default");
      assert.isTrue(profile.openedPages[0]?.closed);
      assert.isFalse(profile.closed);
      assert.isNull(yield* manager.currentTab(threadId));
      unsubscribeRoster();
    }),
  );

  it.effect("resizeViewport restarts a running screencast at the new size", () =>
    Effect.gen(function* () {
      const { manager, profileAt } = yield* createManager();
      yield* manager.open({ threadId, tabId });
      const context = profileAt("default");
      const unsubscribe = yield* manager.attachStream({ threadId, tabId }, () => Effect.void);
      yield* waitFor("screencast started", () =>
        context.cdp.sentMethods().includes("Page.startScreencast"),
      );

      const summary = yield* manager.resizeViewport(threadId, tabId, {
        width: 390,
        height: 844,
      });
      assert.deepEqual(summary.viewport, { width: 390, height: 844 });
      yield* waitFor("screencast restarted", () => {
        const starts = context.cdp.sent.filter((entry) => entry.method === "Page.startScreencast");
        return starts.length === 2;
      });
      unsubscribe();
    }),
  );
});

it.effect("normalizes schemeless and loopback urls", () =>
  Effect.sync(() => {
    assert.equal(normalizeAgentBrowserUrl("t3.chat"), "https://t3.chat");
    assert.equal(normalizeAgentBrowserUrl("localhost:5173/x"), "http://localhost:5173/x");
    assert.equal(normalizeAgentBrowserUrl("https://a.dev/b"), "https://a.dev/b");
    assert.equal(normalizeAgentBrowserUrl("about:blank"), "about:blank");
  }),
);
