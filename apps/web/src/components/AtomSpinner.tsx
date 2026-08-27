import type { CSSProperties } from "react";

import { cn } from "~/lib/utils";

/**
 * A sleek orbital loading indicator: a bright comet sweeps a fading trail
 * around a faint track and a glowing, pulsing core, with a crisp head dot
 * riding the leading edge. Ring thickness scales with `size` so it reads
 * cleanly from ~14px inline chrome up to hero sizes.
 *
 * (Named `AtomSpinner` for backwards compatibility with existing call sites.)
 */
export function AtomSpinner({
  size = 22,
  className,
  label = "Loading",
}: {
  size?: number;
  className?: string;
  label?: string;
}) {
  const stroke = Math.max(1.5, size * 0.1);
  const style = {
    width: size,
    height: size,
    "--orbit-stroke": `${stroke}px`,
  } as CSSProperties;

  return (
    <div role="status" aria-label={label} className={cn("orbit-spinner", className)} style={style}>
      <span className="orbit-spinner__track" />
      <span className="orbit-spinner__comet" />
      <span className="orbit-spinner__head">
        <span className="orbit-spinner__head-dot" />
      </span>
      <span className="orbit-spinner__core" />
    </div>
  );
}
