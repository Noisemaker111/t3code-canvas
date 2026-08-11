import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { BoardSettingsSync } from "./components/BoardSettingsSync";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { VersionBadge } from "./components/VersionBadge";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";
import { AppRoot } from "./AppRoot";

describe("AppRoot", () => {
  it("shares the application atom registry with routed UI and renderer-wide desktop hosts", () => {
    const root = AppRoot({ router: {} as AppRouter });

    expect(root.type).toBe(AppAtomRegistryProvider);
    const types = Children.toArray(
      (root as ReactElement<{ readonly children: ReactNode }>).props.children,
    ).map((child) => (isValidElement(child) ? child.type : child));
    // The spacing overlay is DEV-only, so assert the shipped hosts, not a count.
    expect(types).toContain(BoardSettingsSync);
    expect(types).toContain(RouterProvider);
    expect(types).toContain(PreviewAutomationHosts);
    expect(types).toContain(ElectronBrowserHost);
    expect(types).toContain(VersionBadge);
  });
});
