import { APP_VERSION, BUILD_SHA, BUILD_TIME } from "../branding";

/**
 * Minimal, always-on build stamp pinned to the bottom-right corner.
 *
 * Shows the vps-code deploy commit (BUILD_SHA) so it is obvious at a glance
 * which release is live and when the last update landed. The full build time
 * and app version are exposed via the native tooltip. Intentionally
 * unobtrusive (low opacity, small, click-through) so it never gets in the way.
 */
export function VersionBadge() {
  // Nothing useful to show for un-stamped local dev bundles.
  if (!BUILD_SHA || BUILD_SHA === "dev") {
    return null;
  }

  const buildTimeLabel = formatBuildTime(BUILD_TIME);
  const tooltip = [`T3 Code v${APP_VERSION}`, `build ${BUILD_SHA}`, buildTimeLabel]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      title={tooltip}
      aria-label={tooltip}
      className="pointer-events-none fixed bottom-1.5 right-2 z-[9998] select-none font-mono text-[10px] leading-none tracking-tight text-muted-foreground/50 tabular-nums"
    >
      {BUILD_SHA}
    </div>
  );
}

function formatBuildTime(value: string): string {
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}
