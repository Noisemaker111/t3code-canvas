import type { HermesChipTone } from "../../lib/hermesChip";
import { cn } from "~/lib/utils";

/**
 * The board header's Hermes chip, minus the link it usually sits inside.
 *
 * The header wraps this in a `Link` to the loop's station; the dev gallery
 * renders the same body from a fixture so all four tones are visible without
 * waiting for a tick to go wrong.
 */

export const HERMES_CHIP_CLASS: Record<HermesChipTone, string> = {
  good: "bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-300",
  working: "bg-sky-500/15 text-sky-700 hover:bg-sky-500/25 dark:text-sky-300",
  warn: "bg-amber-500/15 text-amber-700 hover:bg-amber-500/25 dark:text-amber-300",
  bad: "bg-rose-500/15 text-rose-700 hover:bg-rose-500/25 dark:text-rose-300",
};

export function hermesChipClassName(tone: HermesChipTone): string {
  return cn(
    "inline-flex min-w-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium",
    HERMES_CHIP_CLASS[tone],
  );
}

export function HermesChipBody({
  label,
  detail,
  tone,
}: {
  readonly label: string;
  readonly detail: string | null;
  readonly tone: HermesChipTone;
}) {
  return (
    <>
      <span
        className={cn(
          "size-1.5 rounded-full bg-current",
          (tone === "working" || tone === "bad") && "animate-pulse",
        )}
      />
      <span className="truncate">{label}</span>
      {detail ? (
        <span className="max-w-[12rem] truncate font-normal opacity-80">{detail}</span>
      ) : null}
    </>
  );
}
