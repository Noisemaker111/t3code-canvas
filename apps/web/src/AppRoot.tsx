import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { BoardSettingsSync } from "./components/BoardSettingsSync";
import { LayoutSpacingOverlay } from "./components/LayoutSpacingOverlay";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { VersionBadge } from "./components/VersionBadge";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <BoardSettingsSync />
      <RouterProvider router={router} />
      <PreviewAutomationHosts />
      <ElectronBrowserHost />
      <VersionBadge />
      {import.meta.env.DEV ? <LayoutSpacingOverlay /> : null}
    </AppAtomRegistryProvider>
  );
}
