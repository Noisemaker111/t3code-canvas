import { CheckIcon, CopyIcon } from "lucide-react";

import { APP_DISPLAY_NAME } from "../branding";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { Button } from "./ui/button";

export interface CrashScreenProps {
  readonly message: string;
  readonly details: string;
  /** What the copy button puts on the clipboard — the full agent-ready report. */
  readonly copyText: string;
  readonly onTryAgain: () => void;
  readonly onReload: () => void;
}

/** The crash card alone, renderable from props. */
export function CrashScreenCard({
  message,
  details,
  copyText,
  onTryAgain,
  onReload,
}: CrashScreenProps) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "crash-report" });

  return (
    <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
      <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
        {APP_DISPLAY_NAME}
      </p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
        Something went wrong.
      </h1>
      <p className="mt-2 text-sm leading-relaxed wrap-break-word text-muted-foreground select-text">
        {message}
      </p>

      <div className="mt-5 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => copyToClipboard(copyText, undefined)}>
          {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          {isCopied ? "Copied" : "Copy for agent"}
        </Button>
        <Button size="sm" variant="outline" onClick={onTryAgain}>
          Try again
        </Button>
        <Button size="sm" variant="outline" onClick={onReload}>
          Reload app
        </Button>
      </div>

      <pre className="mt-5 max-h-64 overflow-auto rounded-lg border border-border/70 bg-background/80 px-3 py-2 text-xs whitespace-pre-wrap wrap-break-word text-foreground/85 select-text">
        {details}
      </pre>
    </section>
  );
}

export function CrashScreen(props: CrashScreenProps) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-red-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>
      <CrashScreenCard {...props} />
    </div>
  );
}
