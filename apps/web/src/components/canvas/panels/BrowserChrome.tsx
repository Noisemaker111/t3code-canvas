import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BotIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LockIcon,
  MousePointer2Icon,
  TerminalIcon,
  PlusIcon,
  RotateCwIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Kbd } from "~/components/ui/kbd";
import { Spinner } from "~/components/ui/spinner";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { cn } from "~/lib/utils";

import {
  BROWSER_DEVICE_PRESETS,
  browserUrlDisplay,
  browserViewportLabel,
  matchBrowserDevicePreset,
} from "./browserChromeLogic";

/**
 * The browser panel's chrome: tab strip, toolbar and page shell, rendered
 * entirely from props so the dev gallery can show every state without a
 * Chromium session behind it. `BrowserPanel` supplies the wiring.
 */

export interface BrowserChromeTab {
  readonly id: string;
  readonly title: string;
  readonly loading: boolean;
  readonly active: boolean;
}

const CUSTOM_DEVICE = "custom";

export function BrowserChrome({
  tabs,
  url,
  loading,
  viewport,
  driving,
  agentTab = false,
  copied = false,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onSelectDevice,
  onToggleDriving,
  onCopyUrl,
  onOpenExternal,
  onToggleLogs,
  logsOpen,
  logIssues,
  drawer,
  children,
  testId,
}: {
  /** Tab strip rows; `null` hides the strip (a panel bound to one agent tab). */
  readonly tabs: ReadonlyArray<BrowserChromeTab> | null;
  readonly url: string;
  readonly loading: boolean;
  readonly viewport: { readonly width: number; readonly height: number };
  /** Whether human input is being forwarded into the page. */
  readonly driving: boolean;
  /** Marks a tab an agent opened, so spectating reads as deliberate. */
  readonly agentTab?: boolean;
  /** Flips the copy icon to a check while the copy toast is fresh. */
  readonly copied?: boolean;
  readonly onSelectTab?: ((id: string) => void) | undefined;
  readonly onCloseTab?: ((id: string) => void) | undefined;
  readonly onNewTab?: (() => void) | undefined;
  readonly onNavigate: (url: string) => void;
  readonly onBack: () => void;
  readonly onForward: () => void;
  readonly onReload: () => void;
  readonly onSelectDevice: (presetId: string) => void;
  readonly onToggleDriving: () => void;
  readonly onCopyUrl: () => void;
  readonly onOpenExternal: () => void;
  /** Opens the console/network drawer. Absent hides the button entirely. */
  readonly onToggleLogs?: (() => void) | undefined;
  readonly logsOpen?: boolean;
  /** Errors and failed requests so far — the number worth interrupting for. */
  readonly logIssues?: number;
  /** The console/network drawer itself, drawn under the page. */
  readonly drawer?: ReactNode;
  readonly children: ReactNode;
  readonly testId?: string | undefined;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid={testId}>
      {tabs === null ? null : (
        <TabStrip
          tabs={tabs}
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
          onNewTab={onNewTab}
          testId={testId === undefined ? undefined : `${testId}-tabs`}
        />
      )}
      <div className="relative flex shrink-0 items-center gap-1 border-b border-border px-1.5 py-1">
        <ToolbarButton title="Back" onClick={onBack}>
          <ArrowLeftIcon className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton title="Forward" onClick={onForward}>
          <ArrowRightIcon className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton title="Reload" onClick={onReload}>
          <RotateCwIcon className="size-3.5" />
        </ToolbarButton>
        <UrlBar
          url={url}
          onNavigate={onNavigate}
          testId={testId === undefined ? undefined : `${testId}-url`}
        />
        <ToolbarButton title={copied ? "Copied" : "Copy page address"} onClick={onCopyUrl}>
          {copied ? (
            <CheckIcon className="size-3.5 text-success" />
          ) : (
            <CopyIcon className="size-3.5" />
          )}
        </ToolbarButton>
        <ToolbarButton title="Open in your own browser" onClick={onOpenExternal}>
          <ExternalLinkIcon className="size-3.5" />
        </ToolbarButton>
        <Select
          modal={false}
          value={matchBrowserDevicePreset(viewport) ?? CUSTOM_DEVICE}
          onValueChange={(next) => {
            if (next === null || next === CUSTOM_DEVICE) return;
            onSelectDevice(next);
          }}
          items={deviceItems(viewport)}
        >
          <SelectTrigger
            variant="ghost"
            size="xs"
            className="w-24 shrink-0 px-1.5 font-medium"
            aria-label="Screen size"
            data-testid={testId === undefined ? undefined : `${testId}-device`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false} className="min-w-52">
            {matchBrowserDevicePreset(viewport) === null ? (
              <SelectItem value={CUSTOM_DEVICE}>
                <DeviceRow label="Custom" dimensions={browserViewportLabel(viewport)} />
              </SelectItem>
            ) : null}
            {BROWSER_DEVICE_PRESETS.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                <DeviceRow label={preset.label} dimensions={browserViewportLabel(preset)} />
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {agentTab ? (
          <span
            className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
            title="An agent opened this tab and may be driving it"
          >
            <BotIcon className="size-3" />
            Agent
          </span>
        ) : null}
        {onToggleLogs === undefined ? null : (
          <button
            type="button"
            className={cn(
              "flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-colors",
              logsOpen === true
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            title="Console and network"
            data-testid={testId === undefined ? undefined : `${testId}-logs`}
            onClick={onToggleLogs}
          >
            <TerminalIcon className="size-3" />
            {logIssues !== undefined && logIssues > 0 ? (
              <span className="text-destructive">{logIssues}</span>
            ) : null}
          </button>
        )}
        <button
          type="button"
          className={cn(
            "flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-colors",
            driving
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
          title={
            driving
              ? "Your mouse and keyboard go into the page · Esc releases"
              : "Take the mouse and keyboard into the page"
          }
          data-testid={testId === undefined ? undefined : `${testId}-drive`}
          onClick={onToggleDriving}
        >
          <MousePointer2Icon className="size-3" />
          {driving ? "Driving" : "Drive"}
        </button>
        {loading ? (
          <div className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 overflow-hidden">
            <div className="h-full w-1/4 animate-browser-progress rounded-full bg-primary" />
          </div>
        ) : null}
      </div>
      <div className="relative flex min-h-0 flex-1 items-start justify-center overflow-hidden bg-muted/30 p-2">
        {children}
        {driving ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
            <span className="flex items-center gap-1.5 rounded-full border border-border bg-background/90 px-2.5 py-1 text-[10px] font-medium text-muted-foreground shadow-sm backdrop-blur-sm">
              Driving the page · <Kbd>Esc</Kbd> releases
            </span>
          </div>
        ) : null}
      </div>
      {drawer}
    </div>
  );
}

function deviceItems(viewport: { readonly width: number; readonly height: number }) {
  const presets = BROWSER_DEVICE_PRESETS.map((preset) => ({
    value: preset.id,
    label: preset.label,
  }));
  return matchBrowserDevicePreset(viewport) === null
    ? [{ value: CUSTOM_DEVICE, label: browserViewportLabel(viewport) }, ...presets]
    : presets;
}

function DeviceRow({ label, dimensions }: { readonly label: string; readonly dimensions: string }) {
  return (
    <span className="flex w-full items-center justify-between gap-5">
      <span>{label}</span>
      <span className="text-xs tabular-nums text-muted-foreground">{dimensions}</span>
    </span>
  );
}

/**
 * Resting: padlock, bright host, dim path. Click to edit the full URL with it
 * selected; Enter navigates, Esc puts the reading back.
 */
function UrlBar({
  url,
  onNavigate,
  testId,
}: {
  readonly url: string;
  readonly onNavigate: (url: string) => void;
  readonly testId?: string | undefined;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <UrlEditInput
        initial={url === "about:blank" ? "" : url}
        onNavigate={onNavigate}
        onDone={() => setEditing(false)}
        testId={testId}
      />
    );
  }

  const display = browserUrlDisplay(url);
  return (
    <button
      type="button"
      className="flex h-6.5 min-w-0 flex-1 cursor-text items-center gap-1.5 rounded-full border border-transparent bg-muted/60 px-2.5 text-left text-[11px] hover:bg-muted"
      aria-label="Edit page address"
      data-testid={testId}
      onClick={() => setEditing(true)}
    >
      {display === null ? (
        <>
          <GlobeIcon className="size-3 shrink-0 text-muted-foreground/70" />
          <span className="truncate text-muted-foreground/70">Enter an address</span>
        </>
      ) : (
        <>
          {display.secure ? (
            <LockIcon className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <GlobeIcon className="size-3 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">
            <span className="text-foreground">{display.host}</span>
            <span className="text-muted-foreground">{display.rest}</span>
          </span>
        </>
      )}
    </button>
  );
}

/** Mounted only while editing, so focus-and-select runs exactly once. */
function UrlEditInput({
  initial,
  onNavigate,
  onDone,
  testId,
}: {
  readonly initial: string;
  readonly onNavigate: (url: string) => void;
  readonly onDone: () => void;
  readonly testId?: string | undefined;
}) {
  const [draft, setDraft] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      className="h-6.5 min-w-0 flex-1 rounded-full border border-ring/60 bg-background px-3 font-mono text-[11px] text-foreground outline-none ring-2 ring-ring/20"
      value={draft}
      spellCheck={false}
      aria-label="Page address"
      data-testid={testId}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={onDone}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onDone();
          return;
        }
        if (event.key !== "Enter") return;
        const target = draft.trim();
        if (target.length > 0) onNavigate(target);
        onDone();
      }}
    />
  );
}

/** Exported so the board browser's start page keeps the same strip. */
export function TabStrip({
  tabs,
  onSelectTab,
  onCloseTab,
  onNewTab,
  testId,
}: {
  readonly tabs: ReadonlyArray<BrowserChromeTab>;
  readonly onSelectTab?: ((id: string) => void) | undefined;
  readonly onCloseTab?: ((id: string) => void) | undefined;
  readonly onNewTab?: (() => void) | undefined;
  readonly testId?: string | undefined;
}) {
  return (
    <div
      className="flex shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border bg-card/70 px-1.5 pt-1"
      data-testid={testId}
    >
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={cn(
            "group/tab flex h-7 min-w-0 max-w-44 flex-initial cursor-pointer items-center gap-1.5 rounded-t-lg border border-b-0 px-2.5 text-[11px]",
            tab.active
              ? "border-border bg-background font-medium text-foreground"
              : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
          role="tab"
          aria-selected={tab.active}
          tabIndex={0}
          data-testid={testId === undefined ? undefined : `${testId}-tab`}
          onClick={() => onSelectTab?.(tab.id)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") onSelectTab?.(tab.id);
          }}
        >
          {tab.loading ? <Spinner className="size-3 shrink-0 text-muted-foreground" /> : null}
          <span className="truncate">{tab.title}</span>
          {onCloseTab === undefined ? null : (
            <button
              type="button"
              className={cn(
                "-mr-1 flex size-4 shrink-0 items-center justify-center rounded hover:bg-accent hover:text-foreground",
                tab.active ? "" : "opacity-0 group-hover/tab:opacity-100",
              )}
              title="Close tab"
              aria-label={`Close ${tab.title}`}
              onClick={(event) => {
                event.stopPropagation();
                onCloseTab(tab.id);
              }}
            >
              <XIcon className="size-3" />
            </button>
          )}
        </div>
      ))}
      {onNewTab === undefined ? null : (
        <button
          type="button"
          className="mb-0.5 ml-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title="New tab"
          aria-label="New tab"
          data-testid={testId === undefined ? undefined : `${testId}-new`}
          onClick={onNewTab}
        >
          <PlusIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function ToolbarButton({
  title,
  onClick,
  children,
}: {
  readonly title: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
