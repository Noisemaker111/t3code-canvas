import { PREVIEW_VIEWPORT_MAX_AREA, PREVIEW_VIEWPORT_MIN_DIMENSION } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BROWSER_DEVICE_PRESETS,
  browserDevicePreset,
  browserTabTitle,
  browserUrlDisplay,
  browserViewportLabel,
  matchBrowserDevicePreset,
} from "./browserChromeLogic";

describe("browser device presets", () => {
  it("stay within the viewport limits the resize RPC enforces", () => {
    for (const preset of BROWSER_DEVICE_PRESETS) {
      expect(preset.width).toBeGreaterThanOrEqual(PREVIEW_VIEWPORT_MIN_DIMENSION);
      expect(preset.height).toBeGreaterThanOrEqual(PREVIEW_VIEWPORT_MIN_DIMENSION);
      expect(preset.width * preset.height).toBeLessThanOrEqual(PREVIEW_VIEWPORT_MAX_AREA);
    }
  });

  it("match a viewport back to its preset, and only exactly", () => {
    expect(matchBrowserDevicePreset({ width: 1280, height: 800 })).toBe("desktop");
    expect(matchBrowserDevicePreset({ width: 390, height: 844 })).toBe("phone");
    expect(matchBrowserDevicePreset({ width: 1281, height: 800 })).toBeNull();
    expect(browserDevicePreset("tablet")?.height).toBe(1112);
    expect(browserDevicePreset("nonsense")).toBeNull();
  });

  it("label a viewport with its dimensions", () => {
    expect(browserViewportLabel({ width: 834, height: 1112 })).toBe("834 × 1112");
  });
});

describe("browserUrlDisplay", () => {
  it("splits host from the dimmed remainder", () => {
    expect(browserUrlDisplay("https://t3.chat/settings?tab=models#top")).toEqual({
      secure: true,
      host: "t3.chat",
      rest: "/settings?tab=models#top",
    });
  });

  it("hides a bare root path and keeps ports on the host", () => {
    expect(browserUrlDisplay("http://localhost:5173/")).toEqual({
      secure: false,
      host: "localhost:5173",
      rest: "",
    });
  });

  it("shows placeholders for blank tabs", () => {
    expect(browserUrlDisplay("")).toBeNull();
    expect(browserUrlDisplay("about:blank")).toBeNull();
  });

  it("passes through unparseable or non-http urls verbatim, never secure", () => {
    expect(browserUrlDisplay("not a url")).toEqual({ secure: false, host: "not a url", rest: "" });
    expect(browserUrlDisplay("file:///etc/hosts")).toEqual({
      secure: false,
      host: "file:///etc/hosts",
      rest: "",
    });
  });
});

describe("browserTabTitle", () => {
  it("prefers the page title, then the host, then a blank-tab name", () => {
    expect(browserTabTitle({ title: "T3 Chat", url: "https://t3.chat/" })).toBe("T3 Chat");
    expect(browserTabTitle({ title: "  ", url: "https://t3.chat/pricing" })).toBe("t3.chat");
    expect(browserTabTitle({ title: "", url: "about:blank" })).toBe("New tab");
  });
});
