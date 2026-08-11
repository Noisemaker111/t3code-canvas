import {
  CANVAS_COLOR_IDS,
  CANVAS_TOOL_IDS,
  DEFAULT_MINIMAL_CANVAS_COLORS,
  DEFAULT_MINIMAL_CANVAS_TOOLS,
  type CanvasColorId,
  type CanvasToolId,
  type CanvasUiSettings,
} from "@t3tools/contracts";
import { KeyRoundIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  readBoardSettings,
  subscribeBoardSettings,
  updateBoardSettings,
} from "../../lib/boardSettings";
import { readTldrawLicense, resolveTldrawLicenseKey } from "../canvas/tldrawLicense";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection, settingsPageShell } from "./settingsLayout";

/** The drawing surface itself: what its toolbar shows, and the key that keeps it open. */
export function CanvasSettingsPanel({ embedded = false }: { embedded?: boolean } = {}) {
  return settingsPageShell(
    embedded,
    <>
      <CanvasUiSection />
      <CanvasLicenceSection />
    </>,
  );
}

const CANVAS_TOOL_LABELS: Record<CanvasToolId, string> = {
  select: "Select",
  hand: "Hand",
  draw: "Draw",
  eraser: "Eraser",
  rectangle: "Rectangle",
  ellipse: "Circle",
  arrow: "Arrow",
  line: "Line",
  text: "Text",
  note: "Note",
  frame: "Frame",
  highlight: "Highlighter",
  laser: "Laser",
  asset: "Image",
  triangle: "Triangle",
  diamond: "Diamond",
  hexagon: "Hexagon",
  oval: "Oval",
  rhombus: "Rhombus",
  star: "Star",
  cloud: "Cloud",
  heart: "Heart",
  "x-box": "X box",
  "check-box": "Checkbox",
  "arrow-left": "Arrow left",
  "arrow-up": "Arrow up",
  "arrow-down": "Arrow down",
  "arrow-right": "Arrow right",
};

/** tldraw's light-theme solid colors, for the settings swatches only. */
const CANVAS_COLOR_SWATCHES: Record<CanvasColorId, string> = {
  black: "#1d1d1d",
  grey: "#9fa8b2",
  "light-violet": "#e085f4",
  violet: "#ae3ec9",
  blue: "#4465e9",
  "light-blue": "#4ba1f1",
  yellow: "#f1ac4b",
  orange: "#e16919",
  green: "#099268",
  "light-green": "#4cb05e",
  "light-red": "#f87777",
  red: "#e03131",
  white: "#ffffff",
};

/**
 * What the drawing surface shows: toolbar tools, style panel swatches, the
 * minimap and the menu cluster. Ships minimal — most boards want a pen, a
 * couple of shapes and two colors — and every stock tldraw piece is one
 * toggle away. Applies live; no reload.
 */
function CanvasUiSection() {
  const [ui, setUi] = useState<CanvasUiSettings>(() => readBoardSettings().canvasUi);
  useEffect(() => subscribeBoardSettings((settings) => setUi(settings.canvasUi)), []);

  const patch = useCallback(
    (partial: Partial<CanvasUiSettings>) => {
      setUi(updateBoardSettings({ canvasUi: { ...ui, ...partial } }).canvasUi);
    },
    [ui],
  );

  const toggleTool = (id: CanvasToolId) => {
    if (id === "select") return;
    patch({
      tools: ui.tools.includes(id) ? ui.tools.filter((tool) => tool !== id) : [...ui.tools, id],
    });
  };
  const toggleColor = (id: CanvasColorId) => {
    if (ui.colors.includes(id)) {
      if (ui.colors.length === 1) return;
      patch({ colors: ui.colors.filter((color) => color !== id) });
    } else {
      patch({ colors: [...ui.colors, id] });
    }
  };

  const isMinimal =
    ui.stylePanel === "minimal" &&
    !ui.showMinimap &&
    !ui.showMenus &&
    [...ui.tools].sort().join() === [...DEFAULT_MINIMAL_CANVAS_TOOLS].sort().join() &&
    [...ui.colors].sort().join() === [...DEFAULT_MINIMAL_CANVAS_COLORS].sort().join();
  const isEverything =
    ui.stylePanel === "full" &&
    ui.showMinimap &&
    ui.showMenus &&
    ui.tools.length === CANVAS_TOOL_IDS.length &&
    ui.colors.length === CANVAS_COLOR_IDS.length;

  return (
    <SettingsSection title="Canvas UI">
      <SettingsRow
        title="Preset"
        description="Minimal is a pen, eraser, rectangle, circle and two colors. Everything is tldraw's stock UI. Either way, fine-tune below."
        control={
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant={isMinimal ? "default" : "outline"}
              onClick={() =>
                patch({
                  tools: DEFAULT_MINIMAL_CANVAS_TOOLS,
                  colors: DEFAULT_MINIMAL_CANVAS_COLORS,
                  stylePanel: "minimal",
                  showMinimap: false,
                  showMenus: false,
                })
              }
            >
              Minimal
            </Button>
            <Button
              size="xs"
              variant={isEverything ? "default" : "outline"}
              onClick={() =>
                patch({
                  tools: CANVAS_TOOL_IDS,
                  colors: CANVAS_COLOR_IDS,
                  stylePanel: "full",
                  showMinimap: true,
                  showMenus: true,
                })
              }
            >
              Everything
            </Button>
          </div>
        }
      />
      <SettingsRow
        title="Toolbar tools"
        description="Which buttons the toolbar shows. Select always stays — it is how anything gets moved or deleted."
      >
        <div className="flex flex-wrap gap-1.5 pb-3">
          {CANVAS_TOOL_IDS.map((id) => {
            const on = ui.tools.includes(id);
            return (
              <button
                key={id}
                type="button"
                disabled={id === "select"}
                aria-pressed={on}
                className={
                  on
                    ? "rounded-full border border-primary bg-primary/10 px-2.5 py-1 text-[11px] font-medium disabled:opacity-60"
                    : "rounded-full bg-raised/40 px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-accent/40"
                }
                onClick={() => toggleTool(id)}
              >
                {CANVAS_TOOL_LABELS[id]}
              </button>
            );
          })}
        </div>
      </SettingsRow>
      <SettingsRow
        title="Colors"
        description="The swatches the style panel offers. At least one stays on."
      >
        <div className="flex flex-wrap gap-1.5 pb-3">
          {CANVAS_COLOR_IDS.map((id) => {
            const on = ui.colors.includes(id);
            return (
              <button
                key={id}
                type="button"
                aria-pressed={on}
                aria-label={id}
                title={id}
                className={
                  on
                    ? "size-6 rounded-full border border-border ring-2 ring-primary ring-offset-1 ring-offset-background"
                    : "size-6 rounded-full border border-border/70 opacity-45 hover:opacity-80"
                }
                style={{ backgroundColor: CANVAS_COLOR_SWATCHES[id] }}
                onClick={() => toggleColor(id)}
              />
            );
          })}
        </div>
      </SettingsRow>
      <SettingsRow
        title="Style panel"
        description="Minimal is your swatches plus stroke size. Full is tldraw's whole panel — fill, dash, fonts, arrowheads."
        control={
          <Select
            value={ui.stylePanel}
            onValueChange={(value) => {
              if (value === "hidden" || value === "minimal" || value === "full") {
                patch({ stylePanel: value });
              }
            }}
          >
            <SelectTrigger size="xs" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="hidden">Hidden</SelectItem>
              <SelectItem value="minimal">Minimal</SelectItem>
              <SelectItem value="full">Full</SelectItem>
            </SelectContent>
          </Select>
        }
      />
      <SettingsRow
        title="Zoom & minimap"
        description="The navigation cluster in the bottom-left."
        control={
          <Switch
            checked={ui.showMinimap}
            onCheckedChange={(checked) => patch({ showMinimap: Boolean(checked) })}
          />
        }
      />
      <SettingsRow
        title="Menus"
        description="Main menu, actions menu and help menu. Undo and redo stay either way."
        control={
          <Switch
            checked={ui.showMenus}
            onCheckedChange={(checked) => patch({ showMenus: Boolean(checked) })}
          />
        }
      />
    </SettingsSection>
  );
}

/**
 * The canvas licence, set from here rather than a rebuild.
 *
 * tldraw is proprietary and blanks the whole editor five seconds after an
 * unlicensed or expired load — and the board *is* the canvas, so a lapsed key
 * takes the app down. The key used to be build-time only
 * (`VITE_TLDRAW_LICENSE_KEY`), which meant replacing it was a deploy; saved
 * here it applies on the next canvas mount.
 */
function CanvasLicenceSection() {
  const savedKey = usePrimarySettings((settings) => settings.canvasLicenseKey);
  const updateSettings = useUpdatePrimarySettings();
  const [draft, setDraft] = useState(savedKey);

  useEffect(() => setDraft(savedKey), [savedKey]);

  const buildKey = import.meta.env.VITE_TLDRAW_LICENSE_KEY;
  const license = readTldrawLicense(
    resolveTldrawLicenseKey({ settingsKey: savedKey, buildKey }),
    new Date(),
  );
  const status =
    license.kind === "ok"
      ? `Licensed until ${license.expiresOn}.`
      : license.kind === "expiring"
        ? `Expires ${license.expiresOn} — ${license.daysLeft} day${license.daysLeft === 1 ? "" : "s"} left. tldraw blanks the board once it lapses.`
        : license.kind === "expired"
          ? `Expired ${license.expiresOn}. tldraw replaces the board with its own notice.`
          : license.kind === "unparseable"
            ? "This is not a tldraw key, so the board will not stay open."
            : "No key. tldraw runs unlicensed, which blanks the board on any non-development build.";
  const source =
    savedKey.trim().length > 0
      ? "Saved here."
      : buildKey
        ? "From the key this build was compiled with. Paste one here to replace it."
        : "";

  return (
    <SettingsSection title="Canvas licence">
      <SettingsRow
        title="tldraw key"
        description={`${status} ${source} Keys are at tldraw.dev/pricing.`}
        control={
          <div className="flex items-center gap-2">
            <input
              type="text"
              spellCheck={false}
              autoComplete="off"
              placeholder="tldraw-2027-01-01/…"
              className="h-8 w-56 rounded-md bg-raised px-2 font-mono text-xs outline-none focus:border-ring"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button
              size="xs"
              variant="outline"
              disabled={draft.trim() === savedKey}
              onClick={() => updateSettings({ canvasLicenseKey: draft.trim() })}
            >
              <KeyRoundIcon className="size-3.5" />
              Save
            </Button>
          </div>
        }
      />
    </SettingsSection>
  );
}
