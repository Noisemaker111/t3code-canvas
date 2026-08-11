import { LockIcon, MaximizeIcon, MinimizeIcon, SettingsIcon } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";

import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";

/**
 * True while this panel is wearing a title bar. Column panels put count / + /
 * settings in that bar when it is present, and fall back to their own header
 * row when the bar is gone (chromeless).
 */
const PanelTitleBarActiveContext = createContext(false);

export function usePanelTitleBarActive(): boolean {
  return useContext(PanelTitleBarActiveContext);
}

/**
 * The chrome a page wears on the canvas: a title bar you drag it by, a settings
 * cog and maximize in the top right, and the body that only takes the pointer
 * once you have zoomed in on it.
 *
 * Kept free of tldraw so the dev gallery can render it from props — the shape
 * util supplies the real editor behaviour, this supplies the pixels.
 *
 * The header keeps the pointer at every zoom level, even when the body has
 * handed it back to the canvas. It is the one part of a panel that is always a
 * control: moving a panel and maximizing it must not require zooming onto it
 * first.
 */
export function PanelChrome({
  label,
  live,
  focused,
  onToggleFocus,
  onClose,
  closeHint,
  chromeless = false,
  dragging = false,
  locked = false,
  settings,
  menu,
  badge,
  centerLabel = false,
  width,
  height,
  testId,
  onHeaderPointerDown,
  onHeaderDoubleClick,
  onBodyPointerDown,
  onBodyTouchStart,
  children,
}: {
  readonly label: string;
  /** Whether the panel is what you are looking at, so it gets the pointer. */
  readonly live: boolean;
  /** Whether this panel is the focused station, filling the window. */
  readonly focused: boolean;
  /** Omitted when the thing wearing the chrome is not a station. */
  readonly onToggleFocus?: (() => void) | undefined;
  /** Omitted when the panel cannot be closed — the board region never can. */
  readonly onClose?: (() => void) | undefined;
  /** What closing leaves running, for the item's tooltip. */
  readonly closeHint?: string | undefined;
  /** Drop the title bar: something outside the panel is already showing it. */
  readonly chromeless?: boolean;
  /** Whether a title-bar drag is in flight, so the bar reads as held. */
  readonly dragging?: boolean;
  /** Whether the frame is locked in place, so the bar says why it will not move. */
  readonly locked?: boolean;
  /** Extra title-bar controls beside the cog — a column's history / + . */
  readonly settings?: ReactNode;
  /** Rows the cog's menu carries above Close — a column's rules. */
  readonly menu?: ReactNode;
  /** What the panel says about itself at the head of the bar — a column's count. */
  readonly badge?: ReactNode;
  /** Center the title in the bar (kanban columns). Left badge and right controls stay. */
  readonly centerLabel?: boolean;
  /** Authored size. Omitted when a parent sizes the panel (focus, gallery). */
  readonly width?: number;
  readonly height?: number;
  readonly testId?: string | undefined;
  readonly onHeaderPointerDown?: ((event: React.PointerEvent) => void) | undefined;
  readonly onHeaderDoubleClick?: ((event: React.MouseEvent) => void) | undefined;
  readonly onBodyPointerDown?: (event: React.PointerEvent) => void;
  readonly onBodyTouchStart?: (event: React.TouchEvent) => void;
  readonly children: ReactNode;
}) {
  const draggable = !focused && !locked;
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col overflow-hidden bg-card text-foreground",
        dragging && "ring-1 ring-primary/40",
      )}
      style={{ width, height, fontFamily: "var(--font-sans)" }}
      data-testid={testId}
      data-live={live ? "true" : "false"}
      data-focused={focused ? "true" : "false"}
      data-dragging={dragging ? "true" : "false"}
      data-locked={locked ? "true" : "false"}
    >
      {chromeless ? null : (
        <div
          className={cn(
            "group/panel-bar relative flex shrink-0 select-none items-center gap-2 border-b border-border/60 pr-1.5 pl-2",
            focused ? "h-9" : "h-8",
            draggable && (dragging ? "cursor-grabbing" : "cursor-grab"),
          )}
          style={{ pointerEvents: "all", touchAction: draggable ? "none" : undefined }}
          data-testid={testId === undefined ? undefined : `${testId}-titlebar`}
          onPointerDown={onHeaderPointerDown}
          onDoubleClick={onHeaderDoubleClick}
        >
          {badge}
          {locked ? (
            <LockIcon
              aria-label="Locked"
              className="size-3 shrink-0 text-muted-foreground"
              data-testid={testId === undefined ? undefined : `${testId}-locked`}
            />
          ) : null}
          <span
            className={cn(
              "truncate font-medium",
              centerLabel ? "pointer-events-none absolute inset-x-10 text-center" : null,
              focused ? "text-xs text-foreground" : "text-[11px] text-muted-foreground",
            )}
          >
            {label}
          </span>
          <span className="ml-auto flex items-center gap-0.5">
            {settings}
            {menu === undefined && onClose === undefined ? null : (
              <PanelChromeMenu
                focused={focused}
                closeLabel={closeHint === undefined ? "Close" : `Close · ${closeHint}`}
                testId={testId}
                onClose={onClose}
              >
                {menu}
              </PanelChromeMenu>
            )}
            {onToggleFocus === undefined ? null : (
              <ChromeButton
                focused={focused}
                title={focused ? "Restore (Esc)" : "Maximize"}
                label={focused ? "Restore panel" : "Maximize panel"}
                testId={testId === undefined ? undefined : `${testId}-maximize`}
                onClick={onToggleFocus}
              >
                {focused ? (
                  <MinimizeIcon className="size-3.5" />
                ) : (
                  <MaximizeIcon className="size-3" />
                )}
              </ChromeButton>
            )}
          </span>
        </div>
      )}
      <PanelTitleBarActiveContext.Provider value={!chromeless}>
        <div
          className={cn(
            "relative flex min-h-0 flex-1 flex-col",
            live ? "select-text" : "select-none",
          )}
          style={{ pointerEvents: live ? "all" : "none" }}
          onPointerDown={live ? onBodyPointerDown : undefined}
          onTouchStart={live ? onBodyTouchStart : undefined}
        >
          {children}
        </div>
      </PanelTitleBarActiveContext.Provider>
    </div>
  );
}

/**
 * A panel too small to read anything off: the box, and nothing else.
 *
 * The shape draws this behind every panel already (`PanelShapeUtil`); the
 * gallery has no shape behind it, so both draw the same one thing.
 */
export function PanelPlaceholder({
  width,
  height,
}: {
  readonly width?: number;
  readonly height?: number;
}) {
  return (
    <div
      className="size-full bg-card"
      style={{ width, height }}
      data-testid="canvas-panel-placeholder"
    />
  );
}

/**
 * The cog on a panel's title bar: what the page offers, and Close at the foot.
 *
 * Close lives here rather than as its own X: taking a page off the canvas is
 * the one control on the bar you must not hit while reaching for another.
 */
function PanelChromeMenu({
  focused,
  closeLabel,
  testId,
  onClose,
  children,
}: {
  readonly focused: boolean;
  readonly closeLabel: string;
  readonly testId?: string | undefined;
  readonly onClose?: (() => void) | undefined;
  readonly children?: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "inline-flex items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground",
          "pointer-coarse:relative pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11",
          focused ? "size-6" : "size-5",
        )}
        title="Panel settings"
        aria-label="Panel settings"
        data-testid={testId === undefined ? undefined : `${testId}-settings`}
        // The bar owns pointerdown for the drag; a press on the cog is a press
        // on the cog, never the start of a move.
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <SettingsIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        className="w-56 p-1"
        data-testid={testId === undefined ? undefined : `${testId}-settings-menu`}
      >
        {children}
        {onClose === undefined ? null : (
          <PanelMenuItem
            testId={testId === undefined ? undefined : `${testId}-close`}
            onClick={onClose}
          >
            {closeLabel}
          </PanelMenuItem>
        )}
      </PopoverPopup>
    </Popover>
  );
}

/** A row in a panel cog's menu. Exported so a page can add its own. */
export function PanelMenuItem({
  testId,
  onClick,
  children,
}: {
  readonly testId?: string | undefined;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <PopoverClose
      className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent"
      data-testid={testId}
      onClick={onClick}
    >
      {children}
    </PopoverClose>
  );
}

function ChromeButton({
  focused,
  title,
  label,
  testId,
  onClick,
  children,
}: {
  readonly focused: boolean;
  readonly title: string;
  readonly label: string;
  readonly testId?: string | undefined;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground",
        "pointer-coarse:relative pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11",
        focused ? "size-6" : "size-5",
      )}
      title={title}
      aria-label={label}
      data-testid={testId}
      // The bar owns pointerdown for the drag; a press on the button is a press
      // on the button, never the start of a move.
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
