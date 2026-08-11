/**
 * AgentBrowserManager - server-hosted headless Chromium sessions.
 *
 * One shared Chromium process holding one persistent profile, and one page per
 * (threadId, tabId) inside it — so a login, a cookie or a cached session
 * outlives the tab that made it and every tab shares it, the way a browser
 * works. Agents drive pages through the preview automation host
 * (see AutomationHost.ts); humans watch and drive the same pages live from the
 * board canvas via the browser.* WebSocket RPCs. The live view is a CDP
 * screencast fanned out to attached viewers — it never costs agent tokens.
 *
 * @module AgentBrowserManager
 */
import {
  AGENT_BROWSER_DEFAULT_VIEWPORT,
  AgentBrowserLaunchError,
  AgentBrowserOperationError,
  AGENT_BROWSER_DEFAULT_PROFILE,
  AgentBrowserSessionNotFoundError,
  normalizeAgentBrowserProfile,
  PreviewTabId,
  type AgentBrowserAttachInput,
  type AgentBrowserAttachStreamEvent,
  type AgentBrowserCloseInput,
  type AgentBrowserError,
  type AgentBrowserHistoryInput,
  type AgentBrowserInputEvent,
  type AgentBrowserInputInput,
  type AgentBrowserNavigateInput,
  type AgentBrowserOpenInput,
  type AgentBrowserSessionsStreamEvent,
  type AgentBrowserSessionSummary,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import type * as Pw from "playwright-core";
import { chromium } from "playwright-core";

import { resolveChromiumExecutable, type ChromiumProbeLocations } from "./Executable.ts";
import * as ServerConfig from "../config.ts";
import { recordDegradation } from "../health/incidentLog.ts";
import { agentSliceExecutable } from "../process/agentSlice.ts";

const MAX_CONSOLE_ENTRIES = 200;
const MAX_NETWORK_ENTRIES = 200;
const SCREENCAST_QUALITY = 60;

/**
 * How long the CDP ack is held back, which is what sets the frame rate.
 *
 * Chromium asks for the next screencast frame only once the last is acked, so
 * acking on arrival meant a busy page encoded, base64'd and pushed frames as
 * fast as it could paint them — down a JSON socket shared with every transcript
 * and terminal on the board. Pacing here rather than dropping frames later
 * means the work is never done in the first place.
 *
 * It is a governor, not a clock: Chromium still emits roughly two frames per
 * ack window, so measured against a page painting flat out this lands near
 * 29fps, and 500ms lands near 6fps. 80 is the setting that reads as live.
 */
const FRAME_INTERVAL_MS = 80;
const NAVIGATION_TIMEOUT_MS = 15_000;
const DEFAULT_LAUNCH_ARGS = [
  // The t3j service runs as root by design; Chromium refuses the sandbox there.
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--hide-scrollbars",
  "--mute-audio",
];

export interface AgentBrowserConsoleEntry {
  readonly seq: number;
  readonly level: string;
  readonly text: string;
  readonly timestamp: string;
  readonly source?: string;
}

export interface AgentBrowserNetworkEntry {
  readonly seq: number;
  readonly url: string;
  readonly method: string;
  readonly status: number | null;
  readonly failed: boolean;
  readonly errorText?: string;
  readonly timestamp: string;
}

/** Live handles handed to the automation host for one operation. */
export interface AgentBrowserPageHandles {
  readonly page: Pw.Page;
  readonly cdp: Pw.CDPSession;
  readonly summary: AgentBrowserSessionSummary;
  readonly consoleEntries: ReadonlyArray<AgentBrowserConsoleEntry>;
  readonly networkEntries: ReadonlyArray<AgentBrowserNetworkEntry>;
}

export class AgentBrowserManager extends Context.Service<
  AgentBrowserManager,
  {
    /** Open (or reuse) the tab for a thread; navigates when `url` is given. */
    readonly open: (
      input: AgentBrowserOpenInput,
    ) => Effect.Effect<AgentBrowserSessionSummary, AgentBrowserError>;

    readonly navigate: (
      input: AgentBrowserNavigateInput,
    ) => Effect.Effect<AgentBrowserSessionSummary, AgentBrowserError>;

    readonly history: (input: AgentBrowserHistoryInput) => Effect.Effect<void, AgentBrowserError>;

    /** Forward one raw human input event into the page. */
    readonly dispatchInput: (
      input: AgentBrowserInputInput,
    ) => Effect.Effect<void, AgentBrowserError>;

    readonly close: (input: AgentBrowserCloseInput) => Effect.Effect<void, AgentBrowserError>;

    /**
     * Attach a live viewer: initial status event, then screencast frames and
     * status updates. Screencasting runs only while at least one viewer is
     * attached. Returns an unsubscribe function.
     */
    readonly attachStream: (
      input: AgentBrowserAttachInput,
      listener: (event: AgentBrowserAttachStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void, AgentBrowserError>;

    /** Session roster: snapshot then upsert/remove deltas. Returns unsubscribe. */
    readonly subscribeSessions: (
      listener: (event: AgentBrowserSessionsStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;

    /** Latest tab for a thread, if any is running. */
    readonly currentTab: (threadId: ThreadId) => Effect.Effect<AgentBrowserSessionSummary | null>;

    /** Every cookie jar the box has, running or merely stored. Default first. */
    readonly listProfiles: () => Effect.Effect<ReadonlyArray<string>>;

    /** Resize a page's viewport; the screencast follows the new size. */
    readonly resizeViewport: (
      threadId: ThreadId,
      tabId: PreviewTabId | undefined,
      size: { readonly width: number; readonly height: number },
    ) => Effect.Effect<AgentBrowserSessionSummary, AgentBrowserError>;

    /** Run one automation operation against a session's page. */
    readonly usePage: <A>(
      threadId: ThreadId,
      tabId: PreviewTabId | undefined,
      operation: string,
      fn: (handles: AgentBrowserPageHandles) => Promise<A>,
    ) => Effect.Effect<A, AgentBrowserError>;
  }
>()("t3/browser/Manager/AgentBrowserManager") {}

interface SessionState {
  readonly threadId: ThreadId;
  readonly tabId: PreviewTabId;
  /** The cookie jar this tab runs in. A tab never moves between jars. */
  readonly profile: string;
  readonly page: Pw.Page;
  readonly cdp: Pw.CDPSession;
  url: string;
  title: string;
  loading: boolean;
  viewport: { width: number; height: number };
  updatedAt: string;
  /** Monotonic open order, used to pick a thread's most recent tab. */
  openedAt: number;
  closed: boolean;
  screencastRunning: boolean;
  /** The width the running screencast encodes at; 0 while none is running. */
  captureWidth: number;
  /** Row counter for the console and network lists, so every entry has a key. */
  logSequence: number;
  readonly consoleEntries: Array<AgentBrowserConsoleEntry>;
  readonly networkEntries: Array<AgentBrowserNetworkEntry>;
  readonly viewers: Set<Viewer>;
}

/** One attached human view: where frames go, and how big it draws them. */
interface Viewer {
  readonly listener: (event: AgentBrowserAttachStreamEvent) => Effect.Effect<void>;
  readonly captureWidth: number | null;
}

const KEY_VIRTUAL_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
  Meta: 91,
};

const nowIso = () => DateTime.formatIso(DateTime.nowUnsafe());

const toSessionKey = (threadId: string, tabId: string): string => `${threadId}\u0000${tabId}`;

function summarize(session: SessionState): AgentBrowserSessionSummary {
  return {
    threadId: session.threadId,
    tabId: session.tabId,
    profile: session.profile,
    status: session.closed ? "closed" : "running",
    url: session.url,
    title: session.title,
    loading: session.loading,
    viewport: session.viewport,
    updatedAt: session.updatedAt,
  };
}

/** Schemeless hosts get https, loopback hosts http — same rule as the desktop preview. */
export function normalizeAgentBrowserUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed === "about:blank") return trimmed;
  const host = trimmed.split("/")[0] ?? trimmed;
  const bareHost = host.split(":")[0] ?? host;
  const loopback =
    bareHost === "localhost" ||
    bareHost === "127.0.0.1" ||
    bareHost === "0.0.0.0" ||
    bareHost === "::1";
  return `${loopback ? "http" : "https"}://${trimmed}`;
}

interface AgentBrowserManagerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly launch?: (executablePath: string, profileDir: string) => Promise<Pw.BrowserContext>;
  /** Where the jars live — one directory per profile under this one. */
  readonly profileDir?: string;
  /** Overrides the zero-config probe locations; tests pass empty lists. */
  readonly probeLocations?: ChromiumProbeLocations;
}

export const makeWithOptions = Effect.fn("AgentBrowserManager.makeWithOptions")(function* (
  options: AgentBrowserManagerOptions,
) {
  const env = options.env ?? process.env;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const launchLock = yield* Semaphore.make(1);

  const sessions = new Map<string, SessionState>();
  let openSequence = 0;
  const sessionListeners = new Set<
    (event: AgentBrowserSessionsStreamEvent) => Effect.Effect<void>
  >();
  /** One live Chromium per named cookie jar, started the first time it is asked for. */
  const profiles = new Map<string, Pw.BrowserContext>();

  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      const open = [...profiles.values()];
      profiles.clear();
      return Effect.forEach(
        open,
        (context) => Effect.promise(() => context.close().catch(() => undefined)),
        { concurrency: "unbounded", discard: true },
      );
    }),
  );

  const publishSessions = (event: AgentBrowserSessionsStreamEvent) => {
    for (const listener of sessionListeners) {
      runFork(listener(event).pipe(Effect.ignoreCause({ log: true })));
    }
  };

  const publishToViewers = (session: SessionState, event: AgentBrowserAttachStreamEvent) => {
    for (const viewer of session.viewers) {
      runFork(viewer.listener(event).pipe(Effect.ignoreCause({ log: true })));
    }
  };

  /**
   * What the screencast should encode at: the widest attached viewer, never
   * past the page's own width — upscaling a 1280px page to 1920 is bytes spent
   * on nothing. A viewer that has not said (an older client) asks for the page
   * at full size, so one unmeasured viewer opts the session out.
   */
  const captureWidthFor = (session: SessionState): number => {
    let widest = 0;
    for (const viewer of session.viewers) {
      if (viewer.captureWidth === null) return session.viewport.width;
      widest = Math.max(widest, viewer.captureWidth);
    }
    if (widest === 0) return session.viewport.width;
    return Math.min(session.viewport.width, widest);
  };

  const touch = (session: SessionState) => {
    session.updatedAt = nowIso();
    const summary = summarize(session);
    publishSessions({ type: "upsert", session: summary });
    publishToViewers(session, { type: "status", session: summary });
  };

  /**
   * The one profile every tab runs in — a real Chromium user-data directory on
   * the box, not a fresh incognito context per tab.
   *
   * This is what makes the browser usable against your own apps: a login, a
   * cookie banner dismissed, a session token, an IndexedDB cache all survive
   * the tab that made them and the next agent that opens one. Isolated contexts
   * meant "use my app and find issues" started at the login screen every single
   * time, with no way to get past it.
   *
   * One profile also means one cookie jar, which is the trade: two tabs cannot
   * be signed into the same site as different users. That is what a browser
   * does, and it is the behaviour the board wants.
   */
  /** Where the jars live: one directory per profile name. */
  const profilesRoot = () => options.profileDir ?? path.join(process.cwd(), ".t3-browser-profiles");

  const launchProfile = Effect.fn("AgentBrowserManager.launchProfile")(function* (name: string) {
    const running = profiles.get(name);
    if (running !== undefined) return running;
    return yield* launchLock.withPermit(
      Effect.gen(function* () {
        const current = profiles.get(name);
        if (current !== undefined) return current;
        const executablePath = yield* resolveChromiumExecutable(env, options.probeLocations).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        const slicedExecutablePath = yield* agentSliceExecutable("chromium", executablePath).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        const profileDir = path.join(profilesRoot(), name);
        yield* fileSystem
          .makeDirectory(profileDir, { recursive: true })
          .pipe(Effect.ignoreCause({ log: false }));
        const launched = yield* Effect.tryPromise({
          try: () =>
            options.launch
              ? options.launch(executablePath, profileDir)
              : chromium.launchPersistentContext(profileDir, {
                  executablePath: slicedExecutablePath,
                  headless: true,
                  args: DEFAULT_LAUNCH_ARGS,
                  viewport: AGENT_BROWSER_DEFAULT_VIEWPORT,
                  deviceScaleFactor: 1,
                }),
          catch: (cause) => new AgentBrowserLaunchError({ executablePath, cause }),
        });
        profiles.set(name, launched);
        return launched;
      }),
    );
  });

  const requireSession = Effect.fn("AgentBrowserManager.requireSession")(function* (
    threadId: ThreadId,
    tabId: PreviewTabId,
  ): Effect.fn.Return<SessionState, AgentBrowserSessionNotFoundError> {
    const session = sessions.get(toSessionKey(threadId, tabId));
    if (!session || session.closed) {
      return yield* new AgentBrowserSessionNotFoundError({ threadId, tabId });
    }
    return session;
  });

  const latestSessionForThread = (threadId: ThreadId): SessionState | null => {
    let latest: SessionState | null = null;
    for (const session of sessions.values()) {
      if (session.threadId !== threadId || session.closed) continue;
      if (latest === null || session.openedAt > latest.openedAt) latest = session;
    }
    return latest;
  };

  const removeSession = (session: SessionState) => {
    if (session.closed) return;
    session.closed = true;
    sessions.delete(toSessionKey(session.threadId, session.tabId));
    publishToViewers(session, {
      type: "closed",
      threadId: session.threadId,
      tabId: session.tabId,
    });
    session.viewers.clear();
    publishSessions({ type: "remove", threadId: session.threadId, tabId: session.tabId });
  };

  const startScreencast = (session: SessionState) => {
    if (session.screencastRunning || session.closed) return;
    session.screencastRunning = true;
    const width = captureWidthFor(session);
    // Both caps are given, in the page's own aspect ratio: CDP scales a frame
    // to fit inside the box, so a maxHeight left at the viewport's would only
    // matter on a page taller than it is wide, where it would undo the width.
    const height = Math.max(
      1,
      Math.round(session.viewport.height * (width / session.viewport.width)),
    );
    session.captureWidth = width;
    runFork(
      Effect.tryPromise({
        try: () =>
          session.cdp.send("Page.startScreencast", {
            format: "jpeg",
            quality: SCREENCAST_QUALITY,
            maxWidth: width,
            maxHeight: height,
            everyNthFrame: 1,
          }),
        catch: (cause) =>
          new AgentBrowserOperationError({
            operation: "startScreencast",
            threadId: session.threadId,
            tabId: session.tabId,
            cause,
          }),
      }).pipe(Effect.ignoreCause({ log: true })),
    );
  };

  const stopScreencast = (session: SessionState) => {
    if (!session.screencastRunning) return;
    session.screencastRunning = false;
    session.captureWidth = 0;
    if (session.closed) return;
    runFork(
      Effect.tryPromise({
        try: () => session.cdp.send("Page.stopScreencast"),
        catch: (cause) =>
          new AgentBrowserOperationError({
            operation: "stopScreencast",
            threadId: session.threadId,
            tabId: session.tabId,
            cause,
          }),
      }).pipe(Effect.ignoreCause({ log: true })),
    );
  };

  /**
   * Bring the screencast in line with who is watching: none while nobody is,
   * and a restart when the widest viewer changes bucket. One door, so a viewer
   * arriving, leaving or resizing is the same call.
   */
  const syncScreencast = (session: SessionState, options?: { readonly restart?: boolean }) => {
    if (session.viewers.size === 0) {
      stopScreencast(session);
      return;
    }
    if (!session.screencastRunning) {
      startScreencast(session);
      return;
    }
    if (options?.restart !== true && captureWidthFor(session) === session.captureWidth) return;
    stopScreencast(session);
    startScreencast(session);
  };

  const wireSession = (session: SessionState) => {
    const { page, cdp } = session;

    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      session.url = frame.url();
      session.loading = true;
      touch(session);
    });
    page.on("load", () => {
      session.loading = false;
      runFork(
        Effect.tryPromise({
          try: () => page.title(),
          catch: (cause) =>
            new AgentBrowserOperationError({
              operation: "title",
              threadId: session.threadId,
              tabId: session.tabId,
              cause,
            }),
        }).pipe(
          Effect.map((title) => {
            session.title = title;
            touch(session);
          }),
          Effect.ignoreCause({ log: false }),
        ),
      );
    });
    page.on("console", (message) => {
      const entry = {
        seq: (session.logSequence += 1),
        level: message.type(),
        text: message.text().slice(0, 4_000),
        timestamp: nowIso(),
      };
      session.consoleEntries.push(entry);
      if (session.consoleEntries.length > MAX_CONSOLE_ENTRIES) session.consoleEntries.shift();
      publishToViewers(session, { type: "console", entry });
    });
    page.on("response", (response) => {
      const entry = {
        seq: (session.logSequence += 1),
        url: response.url().slice(0, 2_048),
        method: response.request().method(),
        status: response.status(),
        failed: false,
        timestamp: nowIso(),
      };
      session.networkEntries.push(entry);
      if (session.networkEntries.length > MAX_NETWORK_ENTRIES) session.networkEntries.shift();
      publishToViewers(session, { type: "network", entry });
    });
    page.on("requestfailed", (request) => {
      const entry = {
        seq: (session.logSequence += 1),
        url: request.url().slice(0, 2_048),
        method: request.method(),
        status: null,
        failed: true,
        errorText: request.failure()?.errorText ?? "failed",
        timestamp: nowIso(),
      };
      session.networkEntries.push(entry);
      if (session.networkEntries.length > MAX_NETWORK_ENTRIES) session.networkEntries.shift();
      publishToViewers(session, { type: "network", entry });
    });
    page.on("close", () => {
      removeSession(session);
    });

    cdp.on("Page.screencastFrame", (frame) => {
      // The frame goes out now; only the *ack* waits. Chromium sends nothing
      // more until it is acked, so this is the frame rate — set here rather than
      // by dropping frames further down, which would mean encoding, base64ing
      // and socketing a hundred frames a second to throw most of them away.
      runFork(
        Effect.tryPromise({
          try: () => cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }),
          catch: (cause) =>
            new AgentBrowserOperationError({
              operation: "screencastFrameAck",
              threadId: session.threadId,
              tabId: session.tabId,
              cause,
            }),
        }).pipe(Effect.delay(FRAME_INTERVAL_MS), Effect.ignoreCause({ log: false })),
      );
      if (session.viewers.size === 0) return;
      publishToViewers(session, {
        type: "frame",
        frame: {
          data: frame.data,
          deviceWidth: Math.max(1, Math.round(frame.metadata.deviceWidth)),
          deviceHeight: Math.max(1, Math.round(frame.metadata.deviceHeight)),
        },
      });
    });
  };

  const createSession = Effect.fn("AgentBrowserManager.createSession")(function* (
    threadId: ThreadId,
    tabId: PreviewTabId,
    profile: string,
  ): Effect.fn.Return<SessionState, AgentBrowserError> {
    const launched = yield* launchProfile(profile);
    const created = yield* Effect.tryPromise({
      try: async () => {
        // A persistent profile opens holding one blank page. The first tab takes
        // it rather than leaving it parked behind every session for the life of
        // the process.
        // A persistent profile opens holding one blank page; the first tab in
        // that jar takes it instead of leaving it parked forever.
        const spare = launched.pages().find((candidate) => candidate.url() === "about:blank");
        const firstInProfile = ![...sessions.values()].some(
          (candidate) => candidate.profile === profile && !candidate.closed,
        );
        const page = spare !== undefined && firstInProfile ? spare : await launched.newPage();
        const cdp = await launched.newCDPSession(page);
        return { page, cdp };
      },
      catch: (cause) =>
        new AgentBrowserOperationError({ operation: "createSession", threadId, tabId, cause }),
    });
    const session: SessionState = {
      threadId,
      tabId,
      profile,
      page: created.page,
      cdp: created.cdp,
      url: "about:blank",
      title: "",
      loading: false,
      viewport: { ...AGENT_BROWSER_DEFAULT_VIEWPORT },
      updatedAt: nowIso(),
      openedAt: (openSequence += 1),
      closed: false,
      screencastRunning: false,
      captureWidth: 0,
      logSequence: 0,
      consoleEntries: [],
      networkEntries: [],
      viewers: new Set(),
    };
    sessions.set(toSessionKey(threadId, tabId), session);
    wireSession(session);
    publishSessions({ type: "upsert", session: summarize(session) });
    return session;
  });

  const gotoUrl = Effect.fn("AgentBrowserManager.gotoUrl")(function* (
    session: SessionState,
    rawUrl: string,
  ): Effect.fn.Return<void, AgentBrowserError> {
    const url = normalizeAgentBrowserUrl(rawUrl);
    yield* Effect.tryPromise({
      try: () =>
        session.page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }),
      catch: (cause) =>
        new AgentBrowserOperationError({
          operation: "navigate",
          threadId: session.threadId,
          tabId: session.tabId,
          cause,
        }),
    });
    touch(session);
  });

  const open: AgentBrowserManager["Service"]["open"] = Effect.fn("AgentBrowserManager.open")(
    function* (input) {
      const profile = normalizeAgentBrowserProfile(input.profile);
      const candidate =
        input.tabId !== undefined
          ? (sessions.get(toSessionKey(input.threadId, input.tabId)) ?? null)
          : latestSessionForThread(input.threadId);
      // A tab belongs to the jar it was opened in. Asking for a thread's tab in
      // a different profile is asking for a different tab, not a jar swap — the
      // page's cookies are the jar's, and they cannot follow it across.
      const existing =
        candidate !== null && !candidate.closed && candidate.profile === profile ? candidate : null;
      let session: SessionState;
      if (existing !== null) {
        session = existing;
      } else {
        const generated = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        session = yield* createSession(
          input.threadId,
          input.tabId ?? PreviewTabId.make(`tab-${generated}`),
          profile,
        );
      }
      if (input.url !== undefined) {
        yield* gotoUrl(session, input.url);
      }
      return summarize(session);
    },
  );

  const navigate: AgentBrowserManager["Service"]["navigate"] = Effect.fn(
    "AgentBrowserManager.navigate",
  )(function* (input) {
    const session = yield* requireSession(input.threadId, input.tabId);
    yield* gotoUrl(session, input.url);
    return summarize(session);
  });

  const history: AgentBrowserManager["Service"]["history"] = Effect.fn(
    "AgentBrowserManager.history",
  )(function* (input) {
    const session = yield* requireSession(input.threadId, input.tabId);
    yield* Effect.tryPromise({
      try: async () => {
        if (input.direction === "back")
          await session.page.goBack({ timeout: NAVIGATION_TIMEOUT_MS });
        else if (input.direction === "forward")
          await session.page.goForward({ timeout: NAVIGATION_TIMEOUT_MS });
        else await session.page.reload({ timeout: NAVIGATION_TIMEOUT_MS });
      },
      catch: (cause) =>
        new AgentBrowserOperationError({
          operation: `history:${input.direction}`,
          threadId: input.threadId,
          tabId: input.tabId,
          cause,
        }),
    });
    touch(session);
  });

  const dispatchInputEvent = async (session: SessionState, event: AgentBrowserInputEvent) => {
    switch (event.kind) {
      case "mousePressed":
      case "mouseReleased":
      case "mouseMoved":
      case "mouseWheel": {
        await session.cdp.send("Input.dispatchMouseEvent", {
          type: event.kind,
          x: event.x,
          y: event.y,
          button: event.button ?? "none",
          clickCount: event.clickCount ?? 0,
          deltaX: event.deltaX ?? 0,
          deltaY: event.deltaY ?? 0,
          modifiers: event.modifiers ?? 0,
          pointerType: "mouse",
        });
        return;
      }
      case "char": {
        await session.cdp.send("Input.insertText", { text: event.text ?? "" });
        return;
      }
      case "keyDown":
      case "keyUp": {
        const virtualCode = event.key !== undefined ? KEY_VIRTUAL_CODES[event.key] : undefined;
        await session.cdp.send("Input.dispatchKeyEvent", {
          type: event.kind === "keyDown" ? "rawKeyDown" : "keyUp",
          modifiers: event.modifiers ?? 0,
          ...(event.key === undefined ? {} : { key: event.key }),
          ...(event.code === undefined ? {} : { code: event.code }),
          ...(event.text === undefined ? {} : { text: event.text }),
          ...(virtualCode === undefined
            ? {}
            : { windowsVirtualKeyCode: virtualCode, nativeVirtualKeyCode: virtualCode }),
        });
        return;
      }
    }
  };

  const dispatchInput: AgentBrowserManager["Service"]["dispatchInput"] = Effect.fn(
    "AgentBrowserManager.dispatchInput",
  )(function* (input) {
    const session = yield* requireSession(input.threadId, input.tabId);
    yield* Effect.tryPromise({
      try: () => dispatchInputEvent(session, input.event),
      catch: (cause) =>
        new AgentBrowserOperationError({
          operation: "input",
          threadId: input.threadId,
          tabId: input.tabId,
          cause,
        }),
    });
  });

  const close: AgentBrowserManager["Service"]["close"] = Effect.fn("AgentBrowserManager.close")(
    function* (input) {
      const session = sessions.get(toSessionKey(input.threadId, input.tabId));
      if (!session || session.closed) return;
      removeSession(session);
      yield* Effect.tryPromise({
        // The page, not the profile: closing a tab must not sign the box out of
        // every site by taking the shared profile down with it.
        try: () => session.page.close(),
        catch: (cause) =>
          new AgentBrowserOperationError({
            operation: "close",
            threadId: input.threadId,
            tabId: input.tabId,
            cause,
          }),
      }).pipe(Effect.ignoreCause({ log: true }));
    },
  );

  const attachStream: AgentBrowserManager["Service"]["attachStream"] = Effect.fn(
    "AgentBrowserManager.attachStream",
  )(function* (input, listener) {
    const session = yield* requireSession(input.threadId, input.tabId);
    yield* listener({ type: "status", session: summarize(session) });
    // What the page said before this viewer arrived, in one message rather than
    // four hundred: a tab that has been running for an hour still opens with its
    // console and its requests already in the drawer.
    yield* listener({
      type: "logs",
      console: [...session.consoleEntries],
      network: [...session.networkEntries],
    });
    const viewer: Viewer = { listener, captureWidth: input.captureWidth ?? null };
    session.viewers.add(viewer);
    syncScreencast(session);
    return () => {
      session.viewers.delete(viewer);
      syncScreencast(session);
    };
  });

  const subscribeSessions: AgentBrowserManager["Service"]["subscribeSessions"] = Effect.fn(
    "AgentBrowserManager.subscribeSessions",
  )(function* (listener) {
    yield* listener({
      type: "snapshot",
      sessions: [...sessions.values()].filter((session) => !session.closed).map(summarize),
    });
    sessionListeners.add(listener);
    return () => {
      sessionListeners.delete(listener);
    };
  });

  const currentTab: AgentBrowserManager["Service"]["currentTab"] = Effect.fn(
    "AgentBrowserManager.currentTab",
  )(function* (threadId) {
    const session = latestSessionForThread(threadId);
    return session === null ? null : summarize(session);
  });

  /**
   * The jars a human can pick from: the ones on disk, plus any running, plus
   * `default` — which exists whether or not anything has opened it yet.
   */
  const listProfiles: AgentBrowserManager["Service"]["listProfiles"] = Effect.fn(
    "AgentBrowserManager.listProfiles",
  )(function* () {
    const root = profilesRoot();
    // No directory means nothing has ever been stored — an empty list is the
    // true answer. An unreadable one is not: the jars are there and the picker
    // is about to omit them, so say so where a recurring fault is visible.
    const stored = yield* fileSystem.readDirectory(root).pipe(
      Effect.map((entries): ReadonlyArray<string> => entries.map((entry) => entry.toString())),
      Effect.catchTag("PlatformError", (cause) => {
        if (cause.reason._tag !== "NotFound") {
          recordDegradation({
            id: "browser.profiles.unreadable",
            title: "Browser profile directory unreadable",
            detail: `Listed browser cookie jars without the ones on disk under '${root}': ${cause}`,
          });
        }
        return Effect.succeed<ReadonlyArray<string>>([]);
      }),
    );
    const names = new Set<string>([AGENT_BROWSER_DEFAULT_PROFILE, ...stored, ...profiles.keys()]);
    return [...names].toSorted((left, right) =>
      left === AGENT_BROWSER_DEFAULT_PROFILE
        ? -1
        : right === AGENT_BROWSER_DEFAULT_PROFILE
          ? 1
          : left.localeCompare(right),
    );
  });

  const resizeViewport: AgentBrowserManager["Service"]["resizeViewport"] = Effect.fn(
    "AgentBrowserManager.resizeViewport",
  )(function* (threadId, tabId, size) {
    const session =
      tabId !== undefined
        ? yield* requireSession(threadId, tabId)
        : latestSessionForThread(threadId);
    if (session === null) {
      return yield* new AgentBrowserSessionNotFoundError({ threadId, tabId: tabId ?? "current" });
    }
    yield* Effect.tryPromise({
      try: () => session.page.setViewportSize(size),
      catch: (cause) =>
        new AgentBrowserOperationError({
          operation: "resizeViewport",
          threadId: session.threadId,
          tabId: session.tabId,
          cause,
        }),
    });
    session.viewport = { width: size.width, height: size.height };
    // Forced: the capture box is the viewport's aspect ratio, so a resize that
    // leaves the width bucket alone still changes what the encoder should emit.
    syncScreencast(session, { restart: true });
    touch(session);
    return summarize(session);
  });

  const usePage: AgentBrowserManager["Service"]["usePage"] = Effect.fn(
    "AgentBrowserManager.usePage",
  )(function* (threadId, tabId, operation, fn) {
    const session =
      tabId !== undefined
        ? yield* requireSession(threadId, tabId)
        : latestSessionForThread(threadId);
    if (session === null) {
      return yield* new AgentBrowserSessionNotFoundError({ threadId, tabId: tabId ?? "current" });
    }
    const result = yield* Effect.tryPromise({
      try: () =>
        fn({
          page: session.page,
          cdp: session.cdp,
          summary: summarize(session),
          consoleEntries: session.consoleEntries,
          networkEntries: session.networkEntries,
        }),
      catch: (cause) =>
        new AgentBrowserOperationError({
          operation,
          threadId: session.threadId,
          tabId: session.tabId,
          cause,
        }),
    });
    touch(session);
    return result;
  });

  return AgentBrowserManager.of({
    open,
    navigate,
    history,
    dispatchInput,
    close,
    attachStream,
    subscribeSessions,
    currentTab,
    listProfiles,
    resizeViewport,
    usePage,
  });
});

export const make = Effect.fn("AgentBrowserManager.make")(function* () {
  return yield* makeWithOptions({});
});

/**
 * The live manager, with its profile under the server's own state directory —
 * beside the database and the logs, so it is backed up, wiped and moved with
 * the rest of the box's state rather than living somewhere Chromium chose.
 */
export const layer = Layer.effect(
  AgentBrowserManager,
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return yield* makeWithOptions({ profileDir: path.join(stateDir, "browser-profiles") });
  }),
);
