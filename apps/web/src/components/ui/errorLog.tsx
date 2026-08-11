"use client";

import { CheckIcon, CopyIcon, TriangleAlertIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import {
  formatErrorLogForCopy,
  useErrorLogStore,
  type ErrorLogEntry,
} from "~/components/ui/errorLogStore";
import { FixErrorButton } from "~/components/ui/fixErrorButton";

/** Fixed badge, top-right of the viewport: click to review every error toast raised this session. */
export function ErrorLogIndicator() {
  const count = useErrorLogStore((state) => state.entries.length);
  const setModalOpen = useErrorLogStore((state) => state.setModalOpen);

  if (count === 0) {
    return null;
  }

  return (
    <button
      aria-label={`${count} error${count === 1 ? "" : "s"} — view details`}
      className={cn(
        "fixed top-4 right-4 z-110 inline-flex size-7 items-center justify-center rounded-full",
        "bg-destructive text-destructive-foreground shadow-lg/20 ring-2 ring-background",
        "transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
      onClick={() => setModalOpen(true)}
      type="button"
    >
      <TriangleAlertIcon className="size-4" strokeWidth={2.25} />
      {count > 1 ? (
        <span className="absolute -top-1.5 -right-1.5 flex min-w-4 items-center justify-center rounded-full bg-background px-1 text-[10px] font-semibold text-destructive tabular-nums">
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </button>
  );
}

function ErrorLogRow({ entry }: { entry: ErrorLogEntry }) {
  const dismissEntry = useErrorLogStore((state) => state.dismissEntry);

  return (
    <div className="group relative rounded-lg border bg-muted/40 p-3 pr-8 text-sm">
      <button
        aria-label="Dismiss error"
        className="absolute top-2 right-2 inline-flex size-5 items-center justify-center rounded-md text-muted-foreground/80 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
        onClick={() => dismissEntry(entry.id)}
        type="button"
      >
        <XIcon className="size-3.5" />
      </button>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 font-medium wrap-break-word">{entry.title}</p>
        <time className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {new Date(entry.timestamp).toLocaleTimeString()}
        </time>
      </div>
      <p className="mt-1 min-w-0 select-text wrap-break-word text-muted-foreground">
        {entry.description}
      </p>
      <FixErrorButton className="mt-2" errors={[entry]} variant="outline" />
    </div>
  );
}

function CopyAllErrorsButton({ entries }: { entries: ErrorLogEntry[] }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "error-log" });

  return (
    <Button
      onClick={() => copyToClipboard(formatErrorLogForCopy(entries), undefined)}
      size="sm"
      variant="outline"
    >
      {isCopied ? (
        <CheckIcon className="size-3.5 text-success" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
      {isCopied ? "Copied" : "Copy all"}
    </Button>
  );
}

export function ErrorLogModal() {
  const entries = useErrorLogStore((state) => state.entries);
  const isModalOpen = useErrorLogStore((state) => state.isModalOpen);
  const setModalOpen = useErrorLogStore((state) => state.setModalOpen);
  const clear = useErrorLogStore((state) => state.clear);

  return (
    <Dialog onOpenChange={setModalOpen} open={isModalOpen && entries.length > 0}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {entries.length} error{entries.length === 1 ? "" : "s"}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel className="max-h-[60vh]">
          <div className="flex flex-col gap-2">
            {entries.map((entry) => (
              <ErrorLogRow entry={entry} key={entry.id} />
            ))}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button onClick={clear} size="sm" variant="ghost">
            Clear all
          </Button>
          <DialogClose render={<Button size="sm" variant="outline" />}>Close</DialogClose>
          <CopyAllErrorsButton entries={entries} />
          {entries.length > 1 ? (
            <FixErrorButton errors={entries} label="Fix all" variant="default" />
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
