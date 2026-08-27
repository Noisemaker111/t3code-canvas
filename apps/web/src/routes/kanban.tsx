import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronDownIcon,
  FrameIcon,
  LayoutDashboardIcon,
  MoveIcon,
  PencilRulerIcon,
  PlusIcon,
  SettingsIcon,
  TerminalSquareIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useValue, type Editor } from "tldraw";

import { BoardCanvas } from "../components/canvas/BoardCanvas";
import { useCompactShell } from "../components/canvas/panels/compactLayout";
import {
  addFrameEntries,
  addPanelEntries,
  addPanelPlacement,
} from "../components/canvas/panels/addMenu";
import { nextColumnId } from "../components/canvas/panels/boardColumns";
import {
  frameBox,
  frameLabel,
  frameShapes,
  resolveStationToFrame,
} from "../components/canvas/panels/FrameShapeUtil";
import { frameContentBox } from "../components/canvas/panels/panelFrames";
import { panelShapes } from "../components/canvas/panels/PanelShapeUtil";
import { panelLabel } from "../components/canvas/panels/panelLabels";
import {
  isKanbanRegionKind,
  parseStationKey,
  type StationRef,
  stationKey,
} from "../components/canvas/panels/panelStations";
import {
  HERMES_CHIP_CLASS,
  HermesChipBody,
  hermesChipClassName,
} from "../components/kanban/HermesChipView";
import { cardDisplay } from "../components/kanban/KanbanBoard";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../components/ui/menu";
import { SidebarInset } from "../components/ui/sidebar";
import { UsageIndicator } from "../components/UsageIndicator";
import { isElectron } from "../env";
import { readBoardSettings, subscribeBoardSettings } from "../lib/boardSettings";
import { describeHermesChip } from "../lib/hermesChip";
import { useNowMs } from "../lib/useNowMs";
import { cn } from "~/lib/utils";
import { useCanvasStationStore } from "../canvasStationStore";
import { useCanvasViewStore } from "../canvasViewStore";
import { useIsMobile } from "../hooks/useMediaQuery";
import { useKanbanCards } from "../state/kanban";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

function BoardUsageIndicator() {
  const [show, setShow] = useState(() => readBoardSettings().showUsageIndicator);
  useEffect(() => subscribeBoardSettings((s) => setShow(s.showUsageIndicator)), []);
  if (!show) return null;
  return <UsageIndicator threadRef={null} />;
}

function HermesStatusChip({ compact }: { readonly compact: boolean }) {
  const { hermes } = useKanbanCards();
  const [show, setShow] = useState(() => readBoardSettings().showHermesChip);
  const nowMs = useNowMs(1_000);
  useEffect(() => subscribeBoardSettings((s) => setShow(s.showHermesChip)), []);
  if (!show) return null;
  if (!hermes) {
    return compact ? null : (
      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
        Hermes…
      </span>
    );
  }
  if (!hermes.enabled) {
    return (
      <Link
        to="/kanban"
        search={{ station: "settings:hermes" }}
        title="Hermes brain is off. Settings → Hermes to turn it on."
        aria-label="Hermes brain is off"
        className={cn(
          "shrink-0 rounded-full bg-muted font-medium text-muted-foreground",
          compact ? "size-2.5" : "px-2 py-0.5 text-[10px]",
        )}
      >
        {compact ? null : "Hermes off"}
      </Link>
    );
  }
  const state = describeHermesChip(hermes, nowMs);
  // `lastTier` is null on a failed tick that never got a provider, and while a
  // mid-tick is still running — that is not "never ticked". Only say so when
  // the loop has never recorded a beat or a model call.
  const tierLine = hermes.lastTier
    ? `last tier ${hermes.lastTier}`
    : hermes.lastBeatAt !== null || hermes.lastModelAt !== null || hermes.lastSummary
      ? hermes.busy
        ? "mid-tick"
        : "last tier none"
      : "no tick yet";
  const title = [
    state.title,
    `every ${Math.round(hermes.intervalMs / 1000)}s · ${hermes.model}`,
    tierLine,
    hermes.lastSummary ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
  // A phone spends its header width on where you are, not on how the loop is.
  // The chip keeps its tone and its link and gives up its sentence — the words
  // it kept at this size were "I H.. n".
  if (compact) {
    return (
      <Link
        to="/kanban"
        search={{ station: "hermes" }}
        title={title}
        aria-label={state.title}
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-full hover:bg-accent"
      >
        <span
          className={cn(
            "inline-flex size-4 items-center justify-center rounded-full",
            HERMES_CHIP_CLASS[state.tone],
          )}
        >
          <span
            className={cn(
              "size-2 rounded-full bg-current",
              (state.tone === "working" || state.tone === "bad") && "animate-pulse",
            )}
          />
        </span>
      </Link>
    );
  }
  return (
    <Link
      to="/kanban"
      search={{ station: "hermes" }}
      title={title}
      className={hermesChipClassName(state.tone)}
    >
      <HermesChipBody label={state.label} detail={state.detail} tone={state.tone} />
    </Link>
  );
}

/**
 * Put away tldraw's toolbar, style panel and menus.
 *
 * Named and parked next to the pages rather than hidden behind a canvas
 * gesture: the drawing furniture is on screen most of the time and used some of
 * the time, and there has to be one obvious place to say "not now".
 */
function ToolsToggle({ compact }: { readonly compact: boolean }) {
  const toolsHidden = useCanvasViewStore((state) => state.toolsHidden);
  const toggleTools = useCanvasViewStore((state) => state.toggleTools);
  return (
    <button
      type="button"
      onClick={toggleTools}
      data-active={toolsHidden ? undefined : "true"}
      title={
        toolsHidden
          ? "Show the drawing tools — toolbar, styles, canvas menus"
          : "Hide the drawing tools and leave just the pages"
      }
      aria-label={toolsHidden ? "Show the drawing tools" : "Hide the drawing tools"}
      aria-pressed={!toolsHidden}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground data-[active=true]:bg-accent data-[active=true]:text-foreground",
        compact ? "size-9 justify-center" : "px-1.5 py-0.5 text-[11px]",
      )}
    >
      <PencilRulerIcon className={compact ? "size-4" : "size-3.5"} />
      {compact ? null : toolsHidden ? "Tools off" : "Tools"}
    </button>
  );
}

/**
 * Where you are, as the one menu button — every shell gets this and nothing
 * else. The trigger names the place (a frame, a thread, or the open canvas),
 * never a category: everything is canvas, the frames on it are the screens,
 * and the board is just one frame among them. The menu lists everywhere you
 * can go: the canvas itself, the running threads, and every frame.
 */
function StationMenu({
  station,
  editor,
  compact,
}: {
  readonly station: StationRef | null;
  readonly compact: boolean;
  readonly editor: Editor | null;
}) {
  const navigate = useNavigate();
  const { cards } = useKanbanCards();
  const threads = useMemo(
    () =>
      cards
        .filter((card) => card.at === "active" && card.archivedAt === null && card.threadId)
        .toSorted((a, b) => a.position - b.position)
        .map((card) => ({ id: String(card.threadId), title: cardDisplay(card) })),
    [cards],
  );
  const currentThread =
    station?.kind === "thread" ? threads.find((entry) => entry.id === station.entityId) : undefined;
  const currentFrame = useValue(
    "focused frame label",
    () => {
      if (editor === null || station?.kind !== "frame") return null;
      const shape = frameShapes(editor).find((entry) => entry.id === station.entityId);
      return shape === undefined ? null : frameLabel(shape);
    },
    [editor, station],
  );
  const CurrentIcon =
    station === null ? MoveIcon : station.kind === "frame" ? FrameIcon : TerminalSquareIcon;
  const label =
    currentThread?.title ??
    currentFrame ??
    (station === null || station.kind === "frame"
      ? "Canvas"
      : panelLabel(station.kind, station.entityId));

  const go = (ref: StationRef | null) => {
    void navigate({
      to: "/kanban",
      search: ref === null ? {} : { station: stationKey(ref) },
      replace: true,
    });
  };

  return (
    <Menu>
      {/* Shrinkable: a long frame or thread name yields to the controls beside
          it on a phone row instead of pushing them past the edge. */}
      <MenuTrigger
        className={cn(
          "inline-flex min-w-0 max-w-44 shrink items-center rounded-md font-medium text-foreground hover:bg-accent",
          compact ? "h-9 gap-1.5 px-2 text-sm" : "h-6 gap-1 px-1.5 text-[11px]",
        )}
      >
        <CurrentIcon className={cn("shrink-0 opacity-80", compact ? "size-4" : "size-3.5")} />
        <span className="truncate">{label}</span>
        <ChevronDownIcon className={cn("shrink-0 opacity-60", compact ? "size-3.5" : "size-3")} />
      </MenuTrigger>
      <MenuPopup align="end" className="w-56">
        <MenuItem onClick={() => go(null)}>
          <MoveIcon />
          Canvas
          {station === null ? <CheckIcon className="ml-auto size-3.5" /> : null}
        </MenuItem>
        {threads.length > 0 ? <MenuSeparator /> : null}
        {threads.map((thread) => (
          <MenuItem key={thread.id} onClick={() => go({ kind: "thread", entityId: thread.id })}>
            <TerminalSquareIcon />
            <span className="truncate">{thread.title}</span>
            {station?.kind === "thread" && station.entityId === thread.id ? (
              <CheckIcon className="ml-auto size-3.5 shrink-0" />
            ) : null}
          </MenuItem>
        ))}
        <FrameMenuItems editor={editor} station={station} leadingSeparator />
      </MenuPopup>
    </Menu>
  );
}

/**
 * The frames on the canvas, as menu rows.
 *
 * Every frame appends itself here the moment it exists — the list *is* the
 * page, read straight from the shapes — and a row opens that screen the way
 * the old page buttons did: focused, filling the window. Subscribed inside
 * the popup, so the header does not re-render on every canvas edit while the
 * menu is closed.
 */
function FrameMenuItems({
  editor,
  station,
  leadingSeparator = false,
}: {
  readonly editor: Editor | null;
  readonly station: StationRef | null;
  readonly leadingSeparator?: boolean;
}) {
  const navigate = useNavigate();
  const frames = useValue(
    "frame list",
    () => {
      if (editor === null) return [];
      // Two empty frames are both "Frame"; a counted second keeps rows apart.
      const seen = new Map<string, number>();
      return frameShapes(editor).map((shape) => {
        const label = frameLabel(shape);
        const nth = (seen.get(label) ?? 0) + 1;
        seen.set(label, nth);
        return { id: shape.id, label: nth > 1 ? `${label} ${nth}` : label };
      });
    },
    [editor],
  );
  if (editor === null || frames.length === 0) return null;

  const goTo = (frameId: string) => {
    void navigate({
      to: "/kanban",
      search: { station: stationKey({ kind: "frame", entityId: frameId }) },
      replace: true,
    });
  };

  return (
    <>
      {leadingSeparator ? <MenuSeparator /> : null}
      {frames.map((frame) => (
        <MenuItem key={frame.id} onClick={() => goTo(frame.id)}>
          <FrameIcon />
          <span className="truncate">{frame.label}</span>
          {station?.kind === "frame" && station.entityId === frame.id ? (
            <CheckIcon className="ml-auto size-3.5 shrink-0" />
          ) : null}
        </MenuItem>
      ))}
    </>
  );
}

/**
 * Add: the components and the frames, in the app's own chrome.
 *
 * The canvas right-click menu had this list to itself, which made it the one
 * thing you cannot do without a pointer and a piece of bare canvas — and a
 * phone has neither: the focused page fills the window, so there is nothing
 * left to right-click. The IDE and Agents frames have shipped since; nobody
 * with a phone could put one on their canvas, and the command palette listed
 * three of the six frames.
 *
 * Where a component lands is {@link addPanelPlacement}: into the frame you are
 * standing in, or as the page you are on when you are not standing in one. A
 * frame always takes you to it — a rectangle added from up here is otherwise
 * off screen behind whatever you were reading.
 */
function AddMenu({
  compact,
  editor,
  station,
}: {
  readonly compact: boolean;
  readonly editor: Editor | null;
  readonly station: StationRef | null;
}) {
  const requestPanel = useCanvasStationStore((state) => state.requestPanel);
  const requestFrame = useCanvasStationStore((state) => state.requestFrame);
  const frameContent = useValue(
    "focused frame content box",
    () => {
      if (editor === null || station?.kind !== "frame") return null;
      const shape = frameShapes(editor).find((entry) => entry.id === station.entityId);
      return shape === undefined ? null : frameContentBox(frameBox(shape));
    },
    [editor, station],
  );
  const columnIds = (): ReadonlyArray<string> =>
    editor === null
      ? []
      : [...panelShapes(editor).values()]
          .filter((entry) => entry.ref.kind === "column")
          .map((entry) => entry.ref.entityId);

  const addPanel = (kind: string) => {
    const placement = addPanelPlacement({ station, frameContent });
    requestPanel(
      // A column is a component with an address of its own, so adding one mints
      // an id rather than opening "the" column.
      { kind, entityId: kind === "column" ? nextColumnId(columnIds()) : "" },
      {
        ...(placement.at === null ? {} : { at: placement.at }),
        focus: placement.focus,
      },
    );
  };

  return (
    <Menu>
      <MenuTrigger
        title="Add a component or a frame to the canvas"
        aria-label="Add to the canvas"
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
          compact ? "size-9 justify-center" : "px-1.5 py-0.5 text-[11px]",
        )}
      >
        <PlusIcon className={compact ? "size-4" : "size-3.5"} />
        {compact ? null : "Add"}
      </MenuTrigger>
      <MenuPopup align="end" className="w-64">
        <MenuGroup>
          <MenuGroupLabel>Components</MenuGroupLabel>
          {addPanelEntries().map((entry) => (
            <MenuItem key={entry.kind} onClick={() => addPanel(entry.kind)}>
              <LayoutDashboardIcon />
              <span className="truncate">{entry.label}</span>
            </MenuItem>
          ))}
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Frames</MenuGroupLabel>
          {addFrameEntries().map((entry) => (
            <MenuItem
              key={entry.preset}
              onClick={() => requestFrame(entry.preset, { focus: true })}
              className="items-start"
            >
              <FrameIcon className="mt-0.5" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{entry.label}</span>
                <span className="truncate text-[11px] text-muted-foreground">{entry.detail}</span>
              </span>
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

/** The cog. Lands on the settings page wherever it lives — free or framed. */
function SettingsButton({ compact }: { readonly compact: boolean }) {
  return (
    <Link
      to="/kanban"
      search={{ station: "settings" }}
      replace
      title="Settings"
      aria-label="Open settings"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
        compact ? "size-9" : "size-6",
      )}
    >
      <SettingsIcon className={compact ? "size-4" : "size-3.5"} />
    </Link>
  );
}

function KanbanRouteView() {
  const navigate = useNavigate();
  const stationParam = Route.useSearch({ select: (search) => search.station ?? null });
  const narrowShell = useIsMobile();
  const [canvasEditor, setCanvasEditor] = useState<Editor | null>(null);
  // A phone cannot focus a region, so `board` lands on the Prompts page there.
  const parsedStation = useMemo(() => {
    const parsed = parseStationKey(stationParam);
    return narrowShell && parsed !== null && parsed.kind === "board"
      ? ({ kind: "column", entityId: "prompts" } as const)
      : parsed;
  }, [stationParam, narrowShell]);
  // A page docked in a frame has no free panel: its old station key focuses
  // the frame that holds it, so `?station=settings` links keep landing. A
  // phone is the exception for the kanban kinds — the Board frame at 390px is
  // four unreadable strips, so a column station stays itself and the panel
  // layer draws that one page full-window instead.
  const station = useValue(
    "resolved station",
    () =>
      canvasEditor === null || parsedStation === null
        ? parsedStation
        : narrowShell && parsedStation.kind !== "frame" && isKanbanRegionKind(parsedStation.kind)
          ? parsedStation
          : resolveStationToFrame(canvasEditor, parsedStation),
    [canvasEditor, parsedStation, narrowShell],
  );
  const setStation = useCanvasStationStore((state) => state.setStation);
  const requested = useCanvasStationStore((state) => state.requested);
  const requestStation = useCanvasStationStore((state) => state.requestStation);
  const compact = useCompactShell();
  const narrow = useIsMobile();

  useEffect(() => setStation(station), [station, setStation]);

  // A phone opens on a board page, not on the map of it. Free roam is a canvas
  // scaled to a screen five times narrower than the panels parked on it: every
  // page is a thumbnail, and the app looks broken before you have touched it.
  // `board` is a region now, so the page a phone can focus is a column — the
  // Prompts panel wears the column tabs and the composer.
  // Only the landing is redirected — "Canvas" in the menu still roams.
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current) return;
    landed.current = true;
    if (!narrow || station !== null) return;
    void navigate({
      to: "/kanban",
      search: { station: stationKey({ kind: "column", entityId: "prompts" }) },
      replace: true,
    });
  }, [narrow, station, navigate]);

  // Double-clicking a panel is handled inside tldraw's tool state machine,
  // which has no router. It leaves the station here; this turns it into a URL.
  useEffect(() => {
    if (requested === null) return;
    requestStation(null);
    void navigate({ to: "/kanban", search: { station: stationKey(requested) }, replace: true });
  }, [requested, requestStation, navigate]);

  // Escape is "back out to the whole canvas". Anything typing — a composer, a
  // dialog, a rename — gets Escape first; this is only the leftover.
  useEffect(() => {
    if (station === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      const tag = target?.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      void navigate({ to: "/kanban", search: {}, replace: true });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, station]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {!isElectron && (
          <header
            className={cn(
              "shrink-0 border-b border-border px-2 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5 sm:py-2",
              // The inset is the room a collapsed sidebar's rail control needs.
              // A phone has no rail — the sidebar reads collapsed there because
              // it is a phone — so on a compact shell the class was 52px of a
              // 390px row reserved for nothing.
              !compact && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            {compact ? (
              // One row, and every control on it. The wrapped two-row version
              // spent a tenth of a phone screen on chrome and still pushed the
              // tools and the console off the right edge.
              <div className="flex h-11 min-w-0 items-center gap-1">
                <StationMenu compact station={station} editor={canvasEditor} />
                <div className="flex-1" />
                <HermesStatusChip compact />
                <AddMenu compact editor={canvasEditor} station={station} />
                <ToolsToggle compact />
                <SettingsButton compact />
                <BoardUsageIndicator />
              </div>
            ) : (
              <div className="flex min-h-7 flex-wrap items-center gap-2 sm:min-h-6">
                <span className="text-sm font-semibold tracking-tight text-foreground">T3J</span>
                <HermesStatusChip compact={false} />
                <div className="ml-auto flex items-center gap-1">
                  <StationMenu compact={false} station={station} editor={canvasEditor} />
                  <AddMenu compact={false} editor={canvasEditor} station={station} />
                  <ToolsToggle compact={false} />
                  <SettingsButton compact={false} />
                  <BoardUsageIndicator />
                </div>
              </div>
            )}
          </header>
        )}
        {isElectron && (
          <div
            className={cn(
              "drag-region flex h-[52px] shrink-0 items-center gap-2 border-b border-border px-5 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">T3J</span>
            <HermesStatusChip compact={compact} />
            <div className="no-drag ml-auto flex items-center gap-1">
              <StationMenu compact={compact} station={station} editor={canvasEditor} />
              <AddMenu compact={compact} editor={canvasEditor} station={station} />
              <ToolsToggle compact={compact} />
              <SettingsButton compact={compact} />
              <BoardUsageIndicator />
            </div>
          </div>
        )}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <BoardCanvas station={station} onEditor={setCanvasEditor} />
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/kanban")({
  validateSearch: (search: Record<string, unknown>): { station?: string } => {
    const station = search.station;
    return typeof station === "string" && station.length > 0 ? { station } : {};
  },
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: KanbanRouteView,
});
