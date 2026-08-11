/**
 * Pure logic behind the browser panel's chrome: device presets the viewport
 * can be resized to, the two-tone reading of a URL, and what a tab is called
 * when the page has not titled itself yet.
 *
 * No React so the dev gallery catalog and node tests can read it.
 *
 * @module components/canvas/panels/browserChromeLogic
 */

import { AGENT_BROWSER_DEFAULT_PROFILE } from "@t3tools/contracts";

export interface BrowserDevicePreset {
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
}

/** Sizes a human actually tests at. All within the preview viewport limits. */
export const BROWSER_DEVICE_PRESETS: ReadonlyArray<BrowserDevicePreset> = [
  { id: "desktop", label: "Desktop", width: 1280, height: 800 },
  { id: "laptop", label: "Laptop", width: 1440, height: 900 },
  { id: "tablet", label: "Tablet", width: 834, height: 1112 },
  { id: "phone", label: "Phone", width: 390, height: 844 },
];

export function browserDevicePreset(id: string): BrowserDevicePreset | null {
  return BROWSER_DEVICE_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function matchBrowserDevicePreset(viewport: {
  readonly width: number;
  readonly height: number;
}): string | null {
  const match = BROWSER_DEVICE_PRESETS.find(
    (preset) => preset.width === viewport.width && preset.height === viewport.height,
  );
  return match?.id ?? null;
}

export function browserViewportLabel(viewport: {
  readonly width: number;
  readonly height: number;
}): string {
  return `${viewport.width} × ${viewport.height}`;
}

export interface BrowserUrlDisplay {
  /** Whether the URL bar shows the padlock. */
  readonly secure: boolean;
  /** What is emphasized: the host. */
  readonly host: string;
  /** The de-emphasized remainder: path, query, hash. Empty for a bare origin. */
  readonly rest: string;
}

/**
 * The resting reading of the URL bar: host bright, path dim, scheme reduced to
 * the padlock. `null` means the bar shows its placeholder — a blank tab.
 */
export function browserUrlDisplay(url: string): BrowserUrlDisplay | null {
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed === "about:blank") return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { secure: false, host: trimmed, rest: "" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { secure: false, host: trimmed, rest: "" };
  }
  const rest = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return {
    secure: parsed.protocol === "https:",
    host: parsed.host,
    rest: rest === "/" ? "" : rest,
  };
}

/** Tab label: the page title, else the host, else a blank-tab name. */
export function browserTabTitle(session: {
  readonly title: string;
  readonly url: string;
  readonly profile?: string;
}): string {
  const title = session.title.trim();
  const display = browserUrlDisplay(session.url);
  const name =
    title.length > 0
      ? title
      : display !== null && display.host.length > 0
        ? display.host
        : "New tab";
  // Which jar only shows when it is not the default one: two tabs signed in as
  // two different users are otherwise the same row twice.
  const profile = (session.profile ?? "").trim();
  return profile.length === 0 || profile === AGENT_BROWSER_DEFAULT_PROFILE
    ? name
    : `${name} · ${profile}`;
}
