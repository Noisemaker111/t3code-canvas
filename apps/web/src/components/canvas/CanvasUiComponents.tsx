import {
  CANVAS_TOOL_IDS,
  type CanvasColorId,
  type CanvasToolId,
  type CanvasUiSettings,
} from "@t3tools/contracts";
import { type ComponentType, useEffect, useState } from "react";
import {
  ArrowDownToolbarItem,
  ArrowLeftToolbarItem,
  ArrowRightToolbarItem,
  ArrowToolbarItem,
  ArrowUpToolbarItem,
  AssetToolbarItem,
  CheckBoxToolbarItem,
  CloudToolbarItem,
  DefaultActionsMenu,
  DefaultColorStyle,
  DefaultHelpMenu,
  DefaultMainMenu,
  DefaultNavigationPanel,
  DefaultStylePanel,
  DefaultToolbar,
  DefaultToolbarContent,
  DiamondToolbarItem,
  DrawToolbarItem,
  EllipseToolbarItem,
  EraserToolbarItem,
  FrameToolbarItem,
  getColorStyleItems,
  HandToolbarItem,
  HeartToolbarItem,
  HexagonToolbarItem,
  HighlightToolbarItem,
  LaserToolbarItem,
  LineToolbarItem,
  NoteToolbarItem,
  OvalToolbarItem,
  RectangleToolbarItem,
  RhombusToolbarItem,
  SelectToolbarItem,
  StarToolbarItem,
  StylePanelButtonPicker,
  StylePanelSection,
  StylePanelSizePicker,
  TextToolbarItem,
  type TLUiActionsMenuProps,
  type TLUiHelpMenuProps,
  type TLUiMainMenuProps,
  type TLUiStylePanelProps,
  TriangleToolbarItem,
  useEditor,
  useStylePanelContext,
  useValue,
  XBoxToolbarItem,
} from "tldraw";

import { readBoardSettings, subscribeBoardSettings } from "../../lib/boardSettings";

/**
 * The canvas chrome, filtered down to what Settings → General says the owner
 * wants on screen. Most owners want a handful of tools and two colors, not
 * tldraw's whole studio — so the minimal set is the default and every piece of
 * the stock UI is a toggle.
 *
 * Each component here reads the live board settings itself so the objects
 * handed to `<Tldraw components={…}>` keep one identity forever — tldraw
 * recreates its store when that prop changes, which wipes the canvas.
 */

function useCanvasUi(): CanvasUiSettings {
  const [ui, setUi] = useState<CanvasUiSettings>(() => readBoardSettings().canvasUi);
  useEffect(() => subscribeBoardSettings((settings) => setUi(settings.canvasUi)), []);
  return ui;
}

const TOOLBAR_ITEMS: Record<CanvasToolId, ComponentType> = {
  select: SelectToolbarItem,
  hand: HandToolbarItem,
  draw: DrawToolbarItem,
  eraser: EraserToolbarItem,
  rectangle: RectangleToolbarItem,
  ellipse: EllipseToolbarItem,
  arrow: ArrowToolbarItem,
  line: LineToolbarItem,
  text: TextToolbarItem,
  note: NoteToolbarItem,
  frame: FrameToolbarItem,
  highlight: HighlightToolbarItem,
  laser: LaserToolbarItem,
  asset: AssetToolbarItem,
  triangle: TriangleToolbarItem,
  diamond: DiamondToolbarItem,
  hexagon: HexagonToolbarItem,
  oval: OvalToolbarItem,
  rhombus: RhombusToolbarItem,
  star: StarToolbarItem,
  cloud: CloudToolbarItem,
  heart: HeartToolbarItem,
  "x-box": XBoxToolbarItem,
  "check-box": CheckBoxToolbarItem,
  "arrow-left": ArrowLeftToolbarItem,
  "arrow-up": ArrowUpToolbarItem,
  "arrow-down": ArrowDownToolbarItem,
  "arrow-right": ArrowRightToolbarItem,
};

export function CanvasToolbar() {
  const ui = useCanvasUi();
  // Every tool on is the stock toolbar, shape submenu and all — not 28 buttons.
  const everything = ui.tools.length === CANVAS_TOOL_IDS.length;
  return (
    <DefaultToolbar maxItems={9}>
      {everything ? (
        <DefaultToolbarContent />
      ) : (
        ui.tools.map((id) => {
          const Item = TOOLBAR_ITEMS[id];
          return <Item key={id} />;
        })
      )}
    </DefaultToolbar>
  );
}

function CanvasColorPicker({ colors }: { readonly colors: ReadonlyArray<CanvasColorId> }) {
  const editor = useEditor();
  const { styles } = useStylePanelContext();
  const color = styles.get(DefaultColorStyle);
  const items = useValue(
    "canvas ui colors",
    () =>
      getColorStyleItems(editor.getCurrentTheme().colors[editor.getColorMode()]).filter((item) =>
        (colors as ReadonlyArray<string>).includes(item.value),
      ),
    [editor, colors],
  );
  if (color === undefined) return null;
  return (
    <StylePanelButtonPicker
      title="Color"
      uiType="color"
      style={DefaultColorStyle}
      items={items}
      value={color}
    />
  );
}

export function CanvasStylePanel(props: TLUiStylePanelProps) {
  const ui = useCanvasUi();
  if (ui.stylePanel === "hidden") return null;
  if (ui.stylePanel === "full") return <DefaultStylePanel {...props} />;
  return (
    <DefaultStylePanel {...props}>
      <StylePanelSection>
        <CanvasColorPicker colors={ui.colors} />
        <StylePanelSizePicker />
      </StylePanelSection>
    </DefaultStylePanel>
  );
}

export function CanvasNavigationPanel() {
  const ui = useCanvasUi();
  return ui.showMinimap ? <DefaultNavigationPanel /> : null;
}

export function CanvasMainMenu(props: TLUiMainMenuProps) {
  const ui = useCanvasUi();
  return ui.showMenus ? <DefaultMainMenu {...props} /> : null;
}

export function CanvasActionsMenu(props: TLUiActionsMenuProps) {
  const ui = useCanvasUi();
  return ui.showMenus ? <DefaultActionsMenu {...props} /> : null;
}

export function CanvasHelpMenu(props: TLUiHelpMenuProps) {
  const ui = useCanvasUi();
  return ui.showMenus ? <DefaultHelpMenu {...props} /> : null;
}
