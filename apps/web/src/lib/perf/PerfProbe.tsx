import { useEffect, useRef, type ReactNode } from "react";

import { perfNow, recordPerfMount, recordPerfUnmount } from "./perfRecorder";

/**
 * Times what it wraps: how long the subtree took to build, and whether it had
 * been built before.
 *
 * One of these sits inside every panel body ({@link ../../components/canvas/panels/PanelContent}),
 * which is how a recording can say "the thread transcript was rebuilt nine
 * times while you zoomed" rather than "something was slow". A wrapper rather
 * than a hook so the timer belongs to the body's own lifetime, not its parent's.
 *
 * Renders its children and nothing else — no DOM, no layout, and nothing at all
 * to do while no recording is running.
 *
 * @module lib/perf/PerfProbe
 */
export function PerfProbe({
  target,
  children,
}: {
  /** What this is, in the report: a panel address like `thread:t_abc`. */
  readonly target: string;
  readonly children: ReactNode;
}) {
  // First render of this instance — the commit that follows is the build cost.
  const renderedAt = useRef(perfNow());
  useEffect(() => {
    const mountedAt = renderedAt.current;
    recordPerfMount(target, mountedAt);
    return () => recordPerfUnmount(target, mountedAt);
  }, [target]);
  return <>{children}</>;
}
