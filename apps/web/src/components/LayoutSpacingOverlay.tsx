import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "~/lib/utils";

type SpacingSides = { top: number; right: number; bottom: number; left: number };

type ElementColor = {
  /** Solid fill for this element's boxes */
  fill: string;
  /** Stronger outline */
  stroke: string;
  /** Swatch in the list panel */
  swatch: string;
};

type SpacingBox = {
  id: string;
  tag: string;
  label: string;
  color: ElementColor;
  top: number;
  left: number;
  width: number;
  height: number;
  margin: SpacingSides;
  padding: SpacingSides;
};

type Strip = {
  key: string;
  kind: "margin" | "padding";
  color: ElementColor;
  top: number;
  left: number;
  width: number;
  height: number;
};

const SKIP_TAGS = new Set([
  "HTML",
  "HEAD",
  "BODY",
  "SCRIPT",
  "STYLE",
  "LINK",
  "META",
  "NOSCRIPT",
  "TITLE",
  "BR",
  "WBR",
  "PATH",
  "CIRCLE",
  "RECT",
  "LINE",
  "POLYLINE",
  "POLYGON",
  "DEFS",
  "CLIPPATH",
  "MASK",
  "G",
]);

const MAX_ELEMENTS = 400;

/** Stable id per live element for the duration of the page session. */
const elementIds = new WeakMap<Element, string>();
let nextElementId = 1;

function elementId(el: Element): string {
  const existing = elementIds.get(el);
  if (existing) return existing;
  const id = `el-${nextElementId++}`;
  elementIds.set(el, id);
  return id;
}

/**
 * Distinct, high-chroma color per element id. Uses a golden-angle hue walk so
 * neighboring list items / nested boxes don't land on the same color.
 */
function colorForId(id: string): ElementColor {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  // Golden angle (~137.508°) keeps successive hues well separated.
  const hue = (hash * 137.508) % 360;
  const sat = 78 + (hash % 15); // 78–92%
  const light = 52 + ((hash >>> 4) % 12); // 52–63%
  return {
    fill: `hsla(${hue.toFixed(1)}, ${sat}%, ${light}%, 0.48)`,
    stroke: `hsla(${hue.toFixed(1)}, ${Math.min(95, sat + 8)}%, ${Math.max(40, light - 8)}%, 0.95)`,
    swatch: `hsl(${hue.toFixed(1)}, ${sat}%, ${light}%)`,
  };
}

function parsePx(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function isSkippable(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return true;
  if (SKIP_TAGS.has(el.tagName)) return true;
  if (el.closest("[data-layout-spacing-overlay]")) return true;
  return false;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? `${n}` : n.toFixed(1);
}

function sidesSummary(sides: SpacingSides): string {
  if (sides.top === sides.right && sides.right === sides.bottom && sides.bottom === sides.left) {
    return fmt(sides.top);
  }
  return `${fmt(sides.top)} ${fmt(sides.right)} ${fmt(sides.bottom)} ${fmt(sides.left)}`;
}

function elementLabel(el: HTMLElement): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const testId = el.getAttribute("data-testid");
  if (testId) return `${tag}${id}[testid=${testId}]`;
  const cls = typeof el.className === "string" ? el.className.trim() : "";
  if (cls) {
    const parts = cls
      .split(/\s+/)
      .filter((part) => part.length > 0 && !part.startsWith("data-"))
      .slice(0, 2);
    if (parts.length > 0) return `${tag}${id}.${parts.join(".")}`;
  }
  return `${tag}${id}`;
}

function collectSpacingBoxes(): SpacingBox[] {
  const boxes: SpacingBox[] = [];
  const all = document.body?.querySelectorAll("*");
  if (!all) return boxes;

  let count = 0;
  for (const el of all) {
    if (count >= MAX_ELEMENTS) break;
    if (isSkippable(el) || !(el instanceof HTMLElement)) continue;

    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    if (style.opacity === "0") continue;

    const borderBox = el.getBoundingClientRect();
    if (borderBox.width < 2 || borderBox.height < 2) continue;

    const margin = {
      top: parsePx(style.marginTop),
      right: parsePx(style.marginRight),
      bottom: parsePx(style.marginBottom),
      left: parsePx(style.marginLeft),
    };
    const padding = {
      top: parsePx(style.paddingTop),
      right: parsePx(style.paddingRight),
      bottom: parsePx(style.paddingBottom),
      left: parsePx(style.paddingLeft),
    };

    const hasMargin = margin.top > 0 || margin.right > 0 || margin.bottom > 0 || margin.left > 0;
    const hasPadding =
      padding.top > 0 || padding.right > 0 || padding.bottom > 0 || padding.left > 0;
    if (!hasMargin && !hasPadding) continue;

    count += 1;
    const id = elementId(el);
    boxes.push({
      id,
      tag: el.tagName.toLowerCase(),
      label: elementLabel(el),
      color: colorForId(id),
      top: borderBox.top,
      left: borderBox.left,
      width: borderBox.width,
      height: borderBox.height,
      margin,
      padding,
    });
  }

  return boxes;
}

function stripsForBox(box: SpacingBox): Strip[] {
  const strips: Strip[] = [];
  const { top: y, left: x, width: w, height: h, margin: m, padding: p, id, color } = box;

  if (m.top > 0) {
    strips.push({
      key: `${id}-mt`,
      kind: "margin",
      color,
      top: y - m.top,
      left: x - m.left,
      width: w + m.left + m.right,
      height: m.top,
    });
  }
  if (m.bottom > 0) {
    strips.push({
      key: `${id}-mb`,
      kind: "margin",
      color,
      top: y + h,
      left: x - m.left,
      width: w + m.left + m.right,
      height: m.bottom,
    });
  }
  if (m.left > 0) {
    strips.push({
      key: `${id}-ml`,
      kind: "margin",
      color,
      top: y,
      left: x - m.left,
      width: m.left,
      height: h,
    });
  }
  if (m.right > 0) {
    strips.push({
      key: `${id}-mr`,
      kind: "margin",
      color,
      top: y,
      left: x + w,
      width: m.right,
      height: h,
    });
  }

  if (p.top > 0) {
    strips.push({
      key: `${id}-pt`,
      kind: "padding",
      color,
      top: y,
      left: x,
      width: w,
      height: Math.min(p.top, h),
    });
  }
  if (p.bottom > 0) {
    strips.push({
      key: `${id}-pb`,
      kind: "padding",
      color,
      top: y + h - Math.min(p.bottom, h),
      left: x,
      width: w,
      height: Math.min(p.bottom, h),
    });
  }
  if (p.left > 0) {
    const innerH = Math.max(0, h - p.top - p.bottom);
    strips.push({
      key: `${id}-pl`,
      kind: "padding",
      color,
      top: y + p.top,
      left: x,
      width: Math.min(p.left, w),
      height: innerH,
    });
  }
  if (p.right > 0) {
    const innerH = Math.max(0, h - p.top - p.bottom);
    strips.push({
      key: `${id}-pr`,
      kind: "padding",
      color,
      top: y + p.top,
      left: x + w - Math.min(p.right, w),
      width: Math.min(p.right, w),
      height: innerH,
    });
  }

  return strips;
}

/**
 * Press F2 to toggle layout spacing debug.
 * Every element gets its own color (not by margin/padding type). Panel lists
 * each spaced element so you can toggle individuals off while inspecting.
 */
export function LayoutSpacingOverlay() {
  const [enabled, setEnabled] = useState(false);
  const [boxes, setBoxes] = useState<SpacingBox[]>([]);
  /** Element ids the user has turned off. */
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [filter, setFilter] = useState("");
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    tag: string;
    label: string;
    color: ElementColor;
    margin: SpacingSides;
    padding: SpacingSides;
  } | null>(null);
  const boxesRef = useRef<SpacingBox[]>([]);
  const hiddenIdsRef = useRef(hiddenIds);
  hiddenIdsRef.current = hiddenIds;

  const remeasure = useCallback(() => {
    const next = collectSpacingBoxes();
    boxesRef.current = next;
    setBoxes(next);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "F2" || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      setEnabled((prev) => {
        if (prev) {
          setHover(null);
          return false;
        }
        setHiddenIds(new Set());
        setFilter("");
        return true;
      });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setBoxes([]);
      boxesRef.current = [];
      setHover(null);
      return;
    }

    let raf = 0;
    const schedule = () => {
      if (raf !== 0) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        remeasure();
      });
    };

    remeasure();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: false,
    });

    return () => {
      if (raf !== 0) window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      observer.disconnect();
    };
  }, [enabled, remeasure]);

  useEffect(() => {
    if (!enabled) return;

    const onMove = (event: MouseEvent) => {
      const { clientX: x, clientY: y } = event;
      let best: SpacingBox | null = null;
      let bestArea = Number.POSITIVE_INFINITY;
      for (const box of boxesRef.current) {
        if (hiddenIdsRef.current.has(box.id)) continue;
        const outerTop = box.top - box.margin.top;
        const outerLeft = box.left - box.margin.left;
        const outerRight = box.left + box.width + box.margin.right;
        const outerBottom = box.top + box.height + box.margin.bottom;
        if (x < outerLeft || x > outerRight || y < outerTop || y > outerBottom) continue;
        const area =
          (box.width + box.margin.left + box.margin.right) *
          (box.height + box.margin.top + box.margin.bottom);
        if (area < bestArea) {
          bestArea = area;
          best = box;
        }
      }
      if (!best) {
        setHover(null);
        return;
      }
      setHover({
        x,
        y,
        tag: best.tag,
        label: best.label,
        color: best.color,
        margin: best.margin,
        padding: best.padding,
      });
    };

    window.addEventListener("mousemove", onMove, true);
    return () => window.removeEventListener("mousemove", onMove, true);
  }, [enabled]);

  const visibleBoxes = useMemo(
    () => boxes.filter((box) => !hiddenIds.has(box.id)),
    [boxes, hiddenIds],
  );

  const filteredList = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return boxes;
    return boxes.filter(
      (box) =>
        box.label.toLowerCase().includes(q) ||
        box.tag.toLowerCase().includes(q) ||
        box.id.toLowerCase().includes(q),
    );
  }, [boxes, filter]);

  const toggleId = useCallback((id: string) => {
    setHiddenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const showAll = useCallback(() => setHiddenIds(new Set()), []);
  const hideAll = useCallback(() => {
    setHiddenIds(new Set(boxes.map((box) => box.id)));
  }, [boxes]);

  if (!enabled || typeof document === "undefined") return null;

  const strips = visibleBoxes.flatMap(stripsForBox);
  const hiddenCount = hiddenIds.size;

  return createPortal(
    <div
      data-layout-spacing-overlay="true"
      className="pointer-events-none fixed inset-0 z-[2147483646]"
      aria-hidden="true"
    >
      {visibleBoxes.map((box) => (
        <div
          key={`${box.id}-outline`}
          className="absolute box-border"
          style={{
            top: box.top,
            left: box.left,
            width: box.width,
            height: box.height,
            outline: `2px solid ${box.color.stroke}`,
            outlineOffset: 0,
          }}
        />
      ))}

      {strips.map((strip) => (
        <div
          key={strip.key}
          className="absolute box-border"
          style={{
            top: strip.top,
            left: strip.left,
            width: strip.width,
            height: strip.height,
            backgroundColor: strip.color.fill,
            outline: `2px solid ${strip.color.stroke}`,
            // Margin hatches one way, padding the other — same element color, different texture.
            backgroundImage:
              strip.kind === "margin"
                ? "repeating-linear-gradient(45deg, transparent, transparent 3px, rgba(255,255,255,0.28) 3px, rgba(255,255,255,0.28) 6px)"
                : "repeating-linear-gradient(-45deg, transparent, transparent 3px, rgba(0,0,0,0.2) 3px, rgba(0,0,0,0.2) 6px)",
          }}
        />
      ))}

      {hover ? (
        <div
          data-layout-spacing-overlay="tooltip"
          className="absolute z-[2] max-w-xs rounded-lg border border-white/20 bg-black/90 px-2.5 py-2 font-mono text-[11px] text-white shadow-xl"
          style={{
            top: Math.min(hover.y + 14, window.innerHeight - 120),
            left: Math.min(hover.x + 14, window.innerWidth - 240),
          }}
        >
          <div className="mb-1 flex items-center gap-2 font-sans text-[12px] font-semibold text-white/95">
            <span
              className="inline-block size-3 shrink-0 rounded-sm ring-1 ring-white/40"
              style={{ backgroundColor: hover.color.swatch }}
            />
            <span className="truncate">{hover.label}</span>
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
            <span className="text-white/55">margin ↗</span>
            <span>
              {fmt(hover.margin.top)} / {fmt(hover.margin.right)} / {fmt(hover.margin.bottom)} /{" "}
              {fmt(hover.margin.left)}
            </span>
            <span className="text-white/55">padding ↖</span>
            <span>
              {fmt(hover.padding.top)} / {fmt(hover.padding.right)} / {fmt(hover.padding.bottom)} /{" "}
              {fmt(hover.padding.left)}
            </span>
          </div>
        </div>
      ) : null}

      {/* Interactive component list */}
      <div
        data-layout-spacing-overlay="panel"
        className={cn(
          "pointer-events-auto absolute top-3 right-3 z-[3] flex w-[min(22rem,calc(100vw-1.5rem))] flex-col",
          "overflow-hidden rounded-xl border border-white/15 bg-black/92 text-[11px] text-white shadow-2xl backdrop-blur-md",
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
          <div className="min-w-0">
            <div className="font-semibold tracking-wide">Spacing debug</div>
            <div className="text-white/45">
              F2 off · {visibleBoxes.length}/{boxes.length} shown
              {hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ""}
            </div>
          </div>
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              className="rounded-md bg-white/10 px-2 py-1 text-[10px] font-medium hover:bg-white/20"
              onClick={showAll}
            >
              All on
            </button>
            <button
              type="button"
              className="rounded-md bg-white/10 px-2 py-1 text-[10px] font-medium hover:bg-white/20"
              onClick={hideAll}
            >
              All off
            </button>
          </div>
        </div>

        <div className="border-b border-white/10 px-3 py-1.5 text-[10px] text-white/45">
          Each component = its own color · ↗ hatch = margin · ↖ hatch = padding
        </div>

        <div className="border-b border-white/10 px-2 py-1.5">
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter components…"
            className={cn(
              "w-full rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] text-white",
              "placeholder:text-white/35 outline-none focus:border-white/30",
            )}
          />
        </div>

        <div className="max-h-[min(50vh,22rem)] overflow-y-auto overscroll-contain">
          {filteredList.length === 0 ? (
            <div className="px-3 py-4 text-center text-white/40">No spaced elements</div>
          ) : (
            <ul className="divide-y divide-white/5">
              {filteredList.map((box) => {
                const on = !hiddenIds.has(box.id);
                const hasM =
                  box.margin.top > 0 ||
                  box.margin.right > 0 ||
                  box.margin.bottom > 0 ||
                  box.margin.left > 0;
                const hasP =
                  box.padding.top > 0 ||
                  box.padding.right > 0 ||
                  box.padding.bottom > 0 ||
                  box.padding.left > 0;
                return (
                  <li key={box.id}>
                    <button
                      type="button"
                      onClick={() => toggleId(box.id)}
                      className={cn(
                        "flex w-full items-start gap-2 px-2.5 py-1.5 text-left transition-colors",
                        on ? "hover:bg-white/10" : "opacity-45 hover:bg-white/5 hover:opacity-70",
                      )}
                    >
                      <span
                        className="mt-0.5 size-3.5 shrink-0 rounded-sm ring-1 ring-white/30"
                        style={{ backgroundColor: box.color.swatch }}
                        aria-hidden="true"
                      />
                      <span
                        className={cn(
                          "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded border text-[9px]",
                          on
                            ? "border-white/50 bg-white/15 text-white"
                            : "border-white/25 bg-transparent text-transparent",
                        )}
                        aria-hidden="true"
                      >
                        {on ? "✓" : ""}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-[11px] text-white/90">
                          {box.label}
                        </span>
                        <span className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-white/55">
                          {hasM ? <span>m {sidesSummary(box.margin)}</span> : null}
                          {hasP ? <span>p {sidesSummary(box.padding)}</span> : null}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
