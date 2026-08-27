import { useEffect, useState } from "react";

/**
 * Re-render on a clock, for countdowns and "x ago" labels that must not go
 * stale. Pass `false` to stop the interval when nothing on screen needs it.
 */
export function useNowMs(intervalMs: number | false = 1_000): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === false) return;
    const id = window.setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return nowMs;
}
