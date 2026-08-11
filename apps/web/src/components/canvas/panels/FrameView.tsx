import { LockIcon, MaximizeIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { FRAME_HEADER_HEIGHT } from "./panelFrames";

/**
 * A frame's pixels: a title bar, and a border around whatever stands in it.
 *
 * Nothing is drawn inside the border. The panels in a frame are ordinary canvas
 * panels, painted by `PanelLayer` at their own sizes — so the body here is a
 * hole the pointer passes straight through, and a frame can never stretch what
 * is standing in it.
 *
 * Kept free of tldraw so the dev gallery can render it from props, the same
 * split {@link PanelChrome} has. `FrameHost` supplies the editor behaviour.
 *
 * @module components/canvas/panels/FrameView
 */

export function FrameView({
  label,
  size,
  live,
  dragging = false,
  locked = false,
  settings,
  onGoTo,
  onHeaderPointerDown,
  testId,
}: {
  /** What the bar says: the frame's typed name, or its preset's label. */
  readonly label: string;
  /** The frame's box in canvas units — the bar plus the border under it. */
  readonly size: { readonly w: number; readonly h: number };
  /** Whether the frame is close enough to be worth handing the pointer to. */
  readonly live: boolean;
  readonly dragging?: boolean;
  /** Whether the frame is locked in place: no drag, no delete. */
  readonly locked?: boolean;
  /** The title bar's settings control — the cog, supplied by the host. Delete lives in it. */
  readonly settings?: ReactNode;
  /** Fly the camera to this frame. Omitted where there is nowhere to go. */
  readonly onGoTo?: (() => void) | undefined;
  readonly onHeaderPointerDown?: ((event: React.PointerEvent) => void) | undefined;
  readonly testId?: string | undefined;
}) {
  const draggable = !locked;
  return (
    <div
      className="flex flex-col"
      style={{ width: size.w, height: size.h, fontFamily: "var(--font-sans)" }}
      data-testid={testId}
      data-live={live ? "true" : "false"}
      data-dragging={dragging ? "true" : "false"}
      data-locked={locked ? "true" : "false"}
    >
      <div
        className={cn(
          "group/frame-bar flex shrink-0 select-none items-center gap-2 pr-1.5 pl-1",
          draggable && (dragging ? "cursor-grabbing" : "cursor-grab"),
        )}
        style={{
          height: FRAME_HEADER_HEIGHT,
          pointerEvents: "all",
          touchAction: draggable ? "none" : undefined,
        }}
        data-testid={testId === undefined ? undefined : `${testId}-titlebar`}
        onPointerDown={onHeaderPointerDown}
        onDoubleClick={onGoTo}
      >
        {locked ? (
          <LockIcon
            aria-label="Locked"
            className="size-3 shrink-0 text-muted-foreground"
            data-testid={testId === undefined ? undefined : `${testId}-locked`}
          />
        ) : null}
        <span className="truncate text-[11px] font-medium text-muted-foreground">{label}</span>
        <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/frame-bar:opacity-100 focus-within:opacity-100">
          {settings}
          {onGoTo === undefined ? null : (
            <FrameButton
              title="Go to this frame"
              label="Go to frame"
              testId={testId === undefined ? undefined : `${testId}-goto`}
              onClick={onGoTo}
            >
              <MaximizeIcon className="size-3" />
            </FrameButton>
          )}
        </span>
      </div>
      {/* The border, and nothing else: what is inside a frame are shapes of
          their own, so this must never take the pointer off one of them. */}
      <div
        className="min-h-0 flex-1 rounded-2xl border border-border/70"
        style={{ pointerEvents: "none" }}
        data-testid={testId === undefined ? undefined : `${testId}-body`}
      />
    </div>
  );
}

function FrameButton({
  title,
  label,
  testId,
  onClick,
  children,
}: {
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
        "inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground",
        "pointer-coarse:relative pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11",
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
