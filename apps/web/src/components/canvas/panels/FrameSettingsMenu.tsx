import { LockIcon, LockOpenIcon, SettingsIcon } from "lucide-react";

import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/utils";

import {
  FRAME_SIZE_IDS,
  frameContentsSummary,
  frameSize,
  frameSizeLabel,
  matchFrameSize,
  type FrameSizeId,
} from "./panelFrames";
import type { PanelSize } from "./panelRegistry";

/**
 * The cog on a frame's title bar: name, screen size, lock, delete.
 *
 * Kept free of tldraw so the dev gallery can render it from props — the host
 * supplies the shape reads and writes, this supplies the pixels. The popup
 * portals out of the canvas layers, so it works at any zoom without scaling.
 */

const CUSTOM_VALUE = "custom";

export function FrameSettingsMenu({
  title,
  size,
  locked,
  contentCount,
  contentsLocked,
  onTitleChange,
  onSizeChange,
  onLockedChange,
  onContentsLockedChange,
  onDelete,
  testId,
}: {
  /** The frame's typed name. Empty means it is named by its preset. */
  readonly title: string;
  /** The frame's content area in canvas units — what the size picker reads. */
  readonly size: PanelSize;
  readonly locked: boolean;
  /** How many shapes the frame is carrying right now. */
  readonly contentCount: number;
  /** Whether those shapes are locked in rather than left to geometry. */
  readonly contentsLocked: boolean;
  readonly onTitleChange: (next: string) => void;
  readonly onSizeChange: (next: FrameSizeId) => void;
  readonly onLockedChange: (locked: boolean) => void;
  readonly onContentsLockedChange: (locked: boolean) => void;
  /** Omitted while the frame is locked — a locked frame does not go away. */
  readonly onDelete?: (() => void) | undefined;
  readonly testId?: string | undefined;
}) {
  const matched = matchFrameSize(size);
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground",
          "pointer-coarse:relative pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11",
        )}
        title="Frame settings"
        aria-label="Frame settings"
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
        className="w-64"
        data-testid={testId === undefined ? undefined : `${testId}-settings-menu`}
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="frame-title" className="text-xs text-muted-foreground">
              Name
            </Label>
            <Input
              id="frame-title"
              value={title}
              placeholder="Named by its preset"
              aria-label="Frame name"
              data-testid={testId === undefined ? undefined : `${testId}-title`}
              onChange={(event) => onTitleChange(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Screen size</Label>
            <Select
              modal={false}
              value={matched ?? CUSTOM_VALUE}
              onValueChange={(next) => {
                if (next === null || next === CUSTOM_VALUE) return;
                onSizeChange(next as FrameSizeId);
              }}
              items={selectItems(matched)}
            >
              <SelectTrigger
                size="sm"
                className="w-full"
                aria-label="Frame screen size"
                data-testid={testId === undefined ? undefined : `${testId}-size`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false} className="min-w-56">
                {matched === null ? <SelectItem value={CUSTOM_VALUE}>Custom</SelectItem> : null}
                {FRAME_SIZE_IDS.map((id) => (
                  <SelectItem key={id} value={id}>
                    <span className="flex w-full items-center justify-between gap-5">
                      <span>{frameSize(id).label}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {frameSizeLabel(frameSize(id).size)}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              Now {frameSizeLabel(size)}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="flex items-center justify-between gap-3 text-xs">
              <span className="flex items-center gap-1.5 text-foreground">
                {contentsLocked ? (
                  <LockIcon className="size-3.5" />
                ) : (
                  <LockOpenIcon className="size-3.5" />
                )}
                Lock contents in
              </span>
              <Switch
                checked={contentsLocked}
                onCheckedChange={onContentsLockedChange}
                aria-label="Lock contents in frame"
                data-testid={testId === undefined ? undefined : `${testId}-contents-lock`}
              />
            </Label>
            <span
              className="text-[11px] text-muted-foreground"
              data-testid={testId === undefined ? undefined : `${testId}-contents-count`}
            >
              {frameContentsSummary(contentCount, contentsLocked)}
            </span>
          </div>
          <Label className="flex items-center justify-between gap-3 text-xs">
            <span className="flex items-center gap-1.5 text-foreground">
              {locked ? <LockIcon className="size-3.5" /> : <LockOpenIcon className="size-3.5" />}
              Lock frame
            </span>
            <Switch
              checked={locked}
              onCheckedChange={onLockedChange}
              aria-label="Lock frame"
              data-testid={testId === undefined ? undefined : `${testId}-lock`}
            />
          </Label>
          {onDelete === undefined ? null : (
            <PopoverClose
              className="flex w-full items-center rounded border-t border-border pt-2 text-left text-xs text-destructive hover:text-destructive/80"
              title="The pages inside stay on the canvas"
              data-testid={testId === undefined ? undefined : `${testId}-delete`}
              onClick={onDelete}
            >
              Delete frame
            </PopoverClose>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function selectItems(matched: FrameSizeId | null) {
  const presets = FRAME_SIZE_IDS.map((id) => ({ value: id, label: frameSize(id).label }));
  return matched === null ? [{ value: CUSTOM_VALUE, label: "Custom" }, ...presets] : presets;
}
