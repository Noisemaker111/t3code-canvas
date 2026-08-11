import {
  AGENT_BROWSER_DEFAULT_PROFILE,
  agentBrowserCaptureWidth,
  normalizeAgentBrowserProfile,
  type AgentBrowserInputEvent,
  type AgentBrowserSessionSummary,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { GlobeIcon, PanelTopCloseIcon, RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "~/components/ui/autocomplete";
import { Spinner } from "~/components/ui/spinner";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { agentBrowserEnvironment } from "~/state/agentBrowser";
import { usePrimaryEnvironment } from "~/state/environments";
import { formatCauseMessage, useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";

import { BrowserFrameView } from "~/browser/BrowserFrameView";
import { BrowserLogsDrawer } from "~/browser/BrowserLogsDrawer";
import { BrowserChrome, TabStrip, type BrowserChromeTab } from "./BrowserChrome";
import { browserDevicePreset, browserTabTitle } from "./browserChromeLogic";
import {
  boardBrowserThreadId,
  isBoardBrowserSession,
  parseBrowserTabRef,
  type BrowserTabRef,
} from "./panelBrowser";

const MOUSE_MOVE_INTERVAL_MS = 40;
const MOUSE_BUTTONS = ["left", "middle", "right"] as const;

function eventModifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

/**
 * The live view of server-hosted browser tabs.
 *
 * Frames arrive as a CDP screencast over the environment socket and are drawn
 * as plain images — watching an agent browse costs no agent tokens. The board
 * panel (empty entity id) is a real multi-tab browser over every tab a human
 * opened from the canvas; a panel with an explicit entity id fronts the one
 * tab an agent owns. Clicking into the page takes the mouse and keyboard into
 * it; Esc hands them back.
 */
export function BrowserPanel({
  entityId,
  opened,
}: {
  readonly entityId: string;
  readonly opened: boolean;
}) {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const explicitRef = useMemo(() => parseBrowserTabRef(entityId), [entityId]);

  if (environmentId === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Connect an environment to open a browser.
      </div>
    );
  }
  if (!opened) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-1 p-5">
        <p className="mt-auto text-[11px] text-muted-foreground/70">Zoom in to open the page.</p>
      </div>
    );
  }
  return explicitRef === null ? (
    <BoardBrowser environmentId={environmentId} />
  ) : (
    <BrowserTabView
      key={`${explicitRef.threadId}/${explicitRef.tabId}`}
      environmentId={environmentId}
      tab={explicitRef}
      tabs={null}
      agentTab
    />
  );
}

/** The board's own browser: a tab strip over every human-opened tab. */
function BoardBrowser({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const sessions = useEnvironmentQuery(
    agentBrowserEnvironment.sessions({ environmentId, input: null }),
  );
  const boardSessions = useMemo(
    () => (sessions.data ?? []).filter(isBoardBrowserSession),
    [sessions.data],
  );
  const closeBrowser = useAtomCommand(agentBrowserEnvironment.close, "browser close");

  const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
  // The + button shows the start page even while other tabs are open.
  const [composingTab, setComposingTab] = useState(false);

  const selected =
    boardSessions.find((session) => session.tabId === selectedTabId) ??
    boardSessions.at(-1) ??
    null;

  const tabs: ReadonlyArray<BrowserChromeTab> = boardSessions.map((session) => ({
    id: session.tabId,
    title: browserTabTitle(session),
    loading: session.loading,
    active: !composingTab && session.tabId === selected?.tabId,
  }));

  const openTab = useCallback((tabId: string) => {
    setComposingTab(false);
    setSelectedTabId(tabId);
  }, []);

  const closeTab = useCallback(
    (tabId: string) => {
      const session = boardSessions.find((candidate) => candidate.tabId === tabId);
      if (session === undefined) return;
      void closeBrowser({
        environmentId,
        input: { threadId: session.threadId, tabId: session.tabId },
      });
    },
    [boardSessions, closeBrowser, environmentId],
  );

  if (sessions.error !== null) {
    return (
      <BrowserErrorState
        title="The box's browser isn't reachable"
        detail={sessions.error}
        onRetry={sessions.refresh}
      />
    );
  }
  if (sessions.data === undefined || sessions.data === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-xs text-muted-foreground">
        Connecting to the box's browser…
      </div>
    );
  }

  if (composingTab || selected === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {tabs.length > 0 ? (
          <TabStrip tabs={tabs} onSelectTab={openTab} onCloseTab={closeTab} />
        ) : null}
        <BrowserStartPage
          environmentId={environmentId}
          onOpened={(session) => {
            setComposingTab(false);
            setSelectedTabId(session.tabId);
          }}
        />
      </div>
    );
  }

  return (
    <BrowserTabView
      key={`${selected.threadId}/${selected.tabId}`}
      environmentId={environmentId}
      tab={{ threadId: selected.threadId, tabId: selected.tabId }}
      tabs={tabs}
      onSelectTab={openTab}
      onCloseTab={closeTab}
      onNewTab={() => setComposingTab(true)}
    />
  );
}

const QUICK_LINKS = ["localhost:5173", "localhost:3000", "t3.chat"] as const;

/**
 * A browser failure the user must see in the panel: what broke, the exact
 * server reason, and the way back. Props-only so the dev gallery renders it.
 */
export function BrowserErrorState({
  title,
  detail,
  onRetry,
}: {
  readonly title: string;
  readonly detail: string;
  readonly onRetry?: (() => void) | undefined;
}) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6"
      data-testid="browser-error"
    >
      <div className="flex size-12 items-center justify-center rounded-2xl border border-destructive/30 bg-destructive/10">
        <TriangleAlertIcon className="size-5 text-destructive" />
      </div>
      <div className="flex w-full max-w-md flex-col items-center gap-2">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="max-h-36 w-full overflow-y-auto rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-left font-mono text-[11px] leading-relaxed text-destructive">
          {detail}
        </p>
      </div>
      {onRetry === undefined ? null : (
        <button
          type="button"
          className="flex h-8 items-center gap-1.5 rounded-full border border-border px-3.5 text-xs font-medium text-foreground hover:bg-accent"
          onClick={onRetry}
        >
          <RotateCwIcon className="size-3.5" />
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * The start page's presentation, from props — the dev gallery renders this
 * one. A failed open lands in `error`, never only in the console.
 */
export function BrowserStartPageView({
  pending,
  error,
  profiles = [],
  onSubmit,
}: {
  readonly pending: boolean;
  readonly error: string | null;
  /** Cookie jars the box already has. A name not in the list is created. */
  readonly profiles?: ReadonlyArray<string>;
  readonly onSubmit: (url: string, profile: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [profile, setProfile] = useState(AGENT_BROWSER_DEFAULT_PROFILE);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const jarNames = useMemo(
    () => [...new Set([AGENT_BROWSER_DEFAULT_PROFILE, ...profiles])],
    [profiles],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (target: string) => {
    const trimmed = target.trim();
    if (trimmed.length === 0 || pending) return;
    onSubmit(trimmed, profile);
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto p-6"
      data-testid="browser-start"
    >
      <div className="flex flex-col items-center gap-3">
        <div className="flex size-14 items-center justify-center rounded-2xl border border-border bg-gradient-to-b from-muted/40 to-muted shadow-sm">
          <GlobeIcon className="size-6 text-muted-foreground" />
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-base font-semibold text-foreground">Open a page on the box</p>
          <p className="text-xs text-muted-foreground">
            Runs in the box's own Chromium — agents can browse alongside you.
          </p>
        </div>
      </div>
      <div className="flex w-full max-w-lg flex-col gap-2">
        <div
          className={cn(
            "flex h-11 items-center gap-2.5 rounded-full border bg-background pl-4 pr-1.5 shadow-sm transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20",
            error === null ? "border-input" : "border-destructive/50",
          )}
        >
          <GlobeIcon className="size-4 shrink-0 text-muted-foreground/50" />
          <input
            ref={inputRef}
            className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
            placeholder="Enter an address"
            value={url}
            spellCheck={false}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit(url);
            }}
          />
          <button
            type="button"
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            disabled={pending || url.trim().length === 0}
            onClick={() => submit(url)}
          >
            {pending ? <Spinner className="size-3.5" /> : null}
            Open
          </button>
        </div>
        {error === null ? null : (
          <div
            className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2.5"
            data-testid="browser-open-error"
          >
            <TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-destructive" />
            <p className="min-w-0 text-xs leading-relaxed text-destructive">{error}</p>
          </div>
        )}
      </div>
      <div className="flex w-full max-w-lg items-center gap-2">
        {/* Typing a name that is not on the list is how a new jar is made, so
            the list suggests rather than constrains — and it is never filtered
            down to the jar already in the field, which is the one you have. */}
        <Autocomplete
          items={jarNames}
          filter={null}
          value={profile}
          onValueChange={(next) => setProfile(String(next))}
          openOnInputClick
        >
          <AutocompleteInput
            className="h-8 min-w-0 flex-1 rounded-full text-xs"
            spellCheck={false}
            aria-label="Cookie jar"
            data-testid="browser-profile"
            showTrigger
          />
          <AutocompletePopup>
            <AutocompleteList>
              {(name: string) => (
                <AutocompleteItem key={name} value={name}>
                  {name}
                </AutocompleteItem>
              )}
            </AutocompleteList>
          </AutocompletePopup>
        </Autocomplete>
      </div>
      <div className="flex items-center gap-1.5">
        {QUICK_LINKS.map((link) => (
          <button
            key={link}
            type="button"
            className="rounded-full border border-border bg-background px-3 py-1.5 font-mono text-[11px] text-muted-foreground shadow-sm transition-colors hover:border-ring/40 hover:bg-accent hover:text-foreground"
            disabled={pending}
            onClick={() => submit(link)}
          >
            {link}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The start page: where a URL becomes the board's first (or next) tab. */
function BrowserStartPage({
  environmentId,
  onOpened,
}: {
  readonly environmentId: EnvironmentId;
  readonly onOpened: (session: AgentBrowserSessionSummary) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openBrowser = useAtomCommand(agentBrowserEnvironment.open, "browser open");
  const profiles = useEnvironmentQuery(
    agentBrowserEnvironment.profiles({ environmentId, input: {} }),
  );

  const submit = useCallback(
    (target: string, profile: string) => {
      if (pending) return;
      setPending(true);
      setError(null);
      void (async () => {
        try {
          const result = await openBrowser({
            environmentId,
            input: {
              threadId: boardBrowserThreadId,
              url: target,
              // A tab belongs to its jar: asking for another jar gets another
              // tab rather than moving this one, which the box enforces.
              profile: normalizeAgentBrowserProfile(profile),
            },
          });
          if (AsyncResult.isSuccess(result)) {
            onOpened(result.value);
            return;
          }
          setError(formatCauseMessage(result.cause));
        } finally {
          setPending(false);
        }
      })();
    },
    [environmentId, onOpened, openBrowser, pending],
  );

  return (
    <BrowserStartPageView
      pending={pending}
      error={error}
      profiles={profiles.data ?? []}
      onSubmit={submit}
    />
  );
}

/**
 * JPEG frames become short-lived object URLs instead of megabyte data: URIs —
 * the previous URL is revoked as the next frame lands, and the last image
 * stays on screen because revocation only stops new loads.
 */
/**
 * How wide the box should encode this tab, in device pixels, bucketed by
 * {@link agentBrowserCaptureWidth}.
 *
 * A panel on the canvas is drawn at whatever the camera's zoom makes of it, and
 * the box was encoding the page at full viewport width regardless — a 1280px
 * JPEG for a box drawn 400px wide, every frame. Measuring the element and
 * bucketing the answer means the encode follows the window, and a drag or a
 * zoom only costs a re-attach when it crosses a bucket.
 */
function useViewerCaptureWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(() => agentBrowserCaptureWidth(0));
  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      const pixels = entry.contentRect.width * (window.devicePixelRatio || 1);
      setWidth(agentBrowserCaptureWidth(pixels));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function BrowserTabView({
  environmentId,
  tab,
  tabs,
  agentTab = false,
  onSelectTab,
  onCloseTab,
  onNewTab,
}: {
  readonly environmentId: EnvironmentId;
  readonly tab: BrowserTabRef;
  readonly tabs: ReadonlyArray<BrowserChromeTab> | null;
  readonly agentTab?: boolean;
  readonly onSelectTab?: ((tabId: string) => void) | undefined;
  readonly onCloseTab?: ((tabId: string) => void) | undefined;
  readonly onNewTab?: (() => void) | undefined;
}) {
  const viewRef = useRef<HTMLDivElement | null>(null);
  // What the box should encode at. Bucketed hard, so this changes rarely — each
  // distinct value is a fresh attach and a screencast restart on the box.
  const captureWidth = useViewerCaptureWidth(viewRef);
  const attach = useEnvironmentQuery(
    agentBrowserEnvironment.attach({ environmentId, input: { ...tab, captureWidth } }),
  );
  const sendInput = useAtomCommand(agentBrowserEnvironment.input, "browser input");
  const navigate = useAtomCommand(agentBrowserEnvironment.navigate, "browser navigate");
  const history = useAtomCommand(agentBrowserEnvironment.history, "browser history");
  const resize = useAtomCommand(agentBrowserEnvironment.resize, "browser resize");
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "page address" });

  const session = attach.data?.session ?? null;
  const closed = attach.data?.closed ?? false;

  // Humans drive their own tabs from the first click; an agent's tab starts as
  // a spectator so two hands are never on the wheel by accident.
  const [driving, setDriving] = useState(!agentTab);
  const [logsOpen, setLogsOpen] = useState(false);
  const lastMoveRef = useRef(0);
  const consoleEntries = attach.data?.console ?? [];
  const networkEntries = attach.data?.network ?? [];
  // What is worth a number on the button: errors and requests that did not land.
  const logIssues =
    consoleEntries.filter((entry) => entry.level === "error").length +
    networkEntries.filter((entry) => entry.failed || (entry.status ?? 0) >= 400).length;

  const viewportWidth = session?.viewport.width ?? 1280;
  const viewportHeight = session?.viewport.height ?? 800;

  const forward = useCallback(
    (event: AgentBrowserInputEvent) => {
      void sendInput({ environmentId, input: { ...tab, event } });
    },
    [environmentId, sendInput, tab],
  );

  /** Map a pointer event on the scaled image to page CSS-pixel coordinates. */
  const pageCoordinates = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const host = viewRef.current;
      if (host === null) return null;
      const rect = host.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const x = ((event.clientX - rect.left) / rect.width) * viewportWidth;
      const y = ((event.clientY - rect.top) / rect.height) * viewportHeight;
      if (x < 0 || y < 0 || x > viewportWidth || y > viewportHeight) return null;
      return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
    },
    [viewportHeight, viewportWidth],
  );

  const onKey = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!driving) return;
      if (event.key === "Escape") {
        if (event.type === "keydown") setDriving(false);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const modifiers = eventModifiers(event);
      if (event.type === "keyup") {
        forward({ kind: "keyUp", key: event.key, code: event.code, modifiers });
        return;
      }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        forward({ kind: "char", text: event.key, modifiers });
        return;
      }
      forward({ kind: "keyDown", key: event.key, code: event.code, modifiers });
    },
    [driving, forward],
  );

  if (attach.error !== null) {
    return (
      <BrowserErrorState
        title="This tab can't be shown"
        detail={attach.error}
        onRetry={attach.refresh}
      />
    );
  }

  if (closed) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted">
          <PanelTopCloseIcon className="size-5 text-muted-foreground" />
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-foreground">This tab was closed</p>
          <p className="text-xs text-muted-foreground">
            The page and its session are gone from the box.
          </p>
        </div>
      </div>
    );
  }

  const url = session?.url ?? "";

  return (
    <BrowserChrome
      tabs={tabs}
      url={url}
      loading={session?.loading === true}
      viewport={{ width: viewportWidth, height: viewportHeight }}
      driving={driving}
      agentTab={agentTab}
      copied={isCopied}
      onSelectTab={onSelectTab}
      onCloseTab={onCloseTab}
      onNewTab={onNewTab}
      onNavigate={(target) => void navigate({ environmentId, input: { ...tab, url: target } })}
      onBack={() => void history({ environmentId, input: { ...tab, direction: "back" } })}
      onForward={() => void history({ environmentId, input: { ...tab, direction: "forward" } })}
      onReload={() => void history({ environmentId, input: { ...tab, direction: "reload" } })}
      onSelectDevice={(presetId) => {
        const preset = browserDevicePreset(presetId);
        if (preset === null) return;
        void resize({
          environmentId,
          input: { ...tab, viewport: { width: preset.width, height: preset.height } },
        });
      }}
      onToggleLogs={() => setLogsOpen((current) => !current)}
      logsOpen={logsOpen}
      logIssues={logIssues}
      drawer={
        logsOpen ? (
          <BrowserLogsDrawer
            console={consoleEntries}
            network={networkEntries}
            onClose={() => setLogsOpen(false)}
          />
        ) : undefined
      }
      onToggleDriving={() => setDriving((current) => !current)}
      onCopyUrl={() => copyToClipboard(url, undefined)}
      onOpenExternal={() => {
        if (url.length === 0 || url === "about:blank") return;
        window.open(url, "_blank", "noopener,noreferrer");
      }}
      testId="browser-panel"
    >
      <div
        ref={viewRef}
        role="application"
        aria-label="Live browser view"
        tabIndex={0}
        className={cn(
          "relative max-h-full w-full overflow-hidden rounded-lg border bg-background shadow-sm outline-none",
          driving ? "cursor-crosshair border-primary/50 ring-1 ring-primary/40" : "border-border",
        )}
        style={{ aspectRatio: `${viewportWidth} / ${viewportHeight}` }}
        onKeyDown={onKey}
        onKeyUp={onKey}
        onContextMenu={(event) => {
          if (driving) event.preventDefault();
        }}
        onWheel={(event) => {
          if (!driving) return;
          const at = pageCoordinates(event);
          if (at === null) return;
          event.preventDefault();
          forward({
            kind: "mouseWheel",
            ...at,
            deltaX: Math.round(event.deltaX),
            deltaY: Math.round(event.deltaY),
            modifiers: eventModifiers(event),
          });
        }}
        onPointerMove={(event) => {
          if (!driving) return;
          const now = performance.now();
          if (now - lastMoveRef.current < MOUSE_MOVE_INTERVAL_MS) return;
          lastMoveRef.current = now;
          const at = pageCoordinates(event);
          if (at === null) return;
          forward({ kind: "mouseMoved", ...at, modifiers: eventModifiers(event) });
        }}
        onPointerDown={(event) => {
          if (!driving) {
            // The first click takes the wheel; it is not forwarded.
            setDriving(true);
            viewRef.current?.focus();
            return;
          }
          const at = pageCoordinates(event);
          if (at === null) return;
          event.preventDefault();
          viewRef.current?.focus();
          forward({
            kind: "mousePressed",
            ...at,
            button: MOUSE_BUTTONS[event.button] ?? "left",
            clickCount: event.detail > 0 ? event.detail : 1,
            modifiers: eventModifiers(event),
          });
        }}
        onPointerUp={(event) => {
          if (!driving) return;
          const at = pageCoordinates(event);
          if (at === null) return;
          forward({
            kind: "mouseReleased",
            ...at,
            button: MOUSE_BUTTONS[event.button] ?? "left",
            clickCount: event.detail > 0 ? event.detail : 1,
            modifiers: eventModifiers(event),
          });
        }}
      >
        <BrowserFrameView
          threadId={tab.threadId}
          tabId={tab.tabId}
          title={session?.title ?? "Browser page"}
          className="h-full w-full select-none object-contain"
        />
      </div>
    </BrowserChrome>
  );
}
