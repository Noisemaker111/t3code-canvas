"use client";

import { Loader2Icon, WrenchIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useFixError } from "~/hooks/useFixError";
import type { ErrorLogEntry } from "~/components/ui/errorLogStore";

/** Icon-only Fix it, for the tight row of controls on an error toast. */
export function FixErrorIconButton({ errors }: { errors: ReadonlyArray<ErrorLogEntry> }) {
  const { fix, pending } = useFixError();
  const label = pending ? "Starting the fix" : "Fix it";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={label}
            className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md p-0 text-muted-foreground/80 transition-colors hover:text-muted-foreground"
            disabled={pending}
            onClick={() => fix(errors)}
            type="button"
          />
        }
      >
        {pending ? (
          <Loader2Icon className="size-3 animate-spin" />
        ) : (
          <WrenchIcon className="size-3" />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function FixErrorButton({
  errors,
  label = "Fix it",
  className,
  variant = "outline",
}: {
  readonly errors: ReadonlyArray<ErrorLogEntry>;
  readonly label?: string;
  readonly className?: string;
  readonly variant?: "default" | "ghost" | "outline" | "secondary";
}) {
  const { fix, pending } = useFixError();

  return (
    <Button
      className={cn(className)}
      disabled={pending}
      onClick={() => fix(errors)}
      size="sm"
      type="button"
      variant={variant}
    >
      {pending ? (
        <Loader2Icon className="size-3.5 animate-spin" />
      ) : (
        <WrenchIcon className="size-3.5" />
      )}
      {label}
    </Button>
  );
}
