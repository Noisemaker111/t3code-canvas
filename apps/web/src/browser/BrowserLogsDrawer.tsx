import type { AgentBrowserConsoleEntry, AgentBrowserNetworkEntry } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";

/**
 * What the page said and what it fetched, under the page it belongs to.
 *
 * The box already collected both for the agents' `preview_*` tools; the human
 * watching the same tab could see neither, which made "use my app and find
 * issues" a question you could only ask an agent. Same two lists, same tab,
 * live.
 */
export function BrowserLogsDrawer({
  console: consoleEntries,
  network,
  onClose,
}: {
  readonly console: ReadonlyArray<AgentBrowserConsoleEntry>;
  readonly network: ReadonlyArray<AgentBrowserNetworkEntry>;
  readonly onClose: () => void;
}) {
  const [tab, setTab] = useState<"console" | "network">("console");
  return (
    <div
      className="flex h-48 shrink-0 flex-col border-t border-border bg-background"
      data-testid="browser-logs"
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-1.5 py-1">
        <LogTab
          label="Console"
          count={consoleEntries.length}
          active={tab === "console"}
          onClick={() => setTab("console")}
        />
        <LogTab
          label="Network"
          count={network.length}
          active={tab === "network"}
          onClick={() => setTab("network")}
        />
        <button
          type="button"
          className="ml-auto flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Close"
          onClick={onClose}
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-[11px]">
        {tab === "console"
          ? consoleEntries.map((entry) => (
              <div
                key={entry.seq}
                className={cn(
                  "flex gap-2 border-b border-border/40 px-2 py-1",
                  entry.level === "error"
                    ? "text-destructive"
                    : entry.level === "warning"
                      ? "text-warning"
                      : "text-foreground",
                )}
              >
                <span className="shrink-0 text-muted-foreground">{entry.level}</span>
                <span className="whitespace-pre-wrap break-all">{entry.text}</span>
              </div>
            ))
          : network.map((entry) => (
              <div
                key={entry.seq}
                className={cn(
                  "flex gap-2 border-b border-border/40 px-2 py-1",
                  entry.failed || (entry.status !== null && entry.status >= 400)
                    ? "text-destructive"
                    : "text-foreground",
                )}
              >
                <span className="w-8 shrink-0 text-muted-foreground">
                  {entry.failed ? "—" : entry.status}
                </span>
                <span className="w-12 shrink-0 text-muted-foreground">{entry.method}</span>
                <span className="truncate">{entry.errorText ?? entry.url}</span>
              </div>
            ))}
      </div>
    </div>
  );
}

function LogTab({
  label,
  count,
  active,
  onClick,
}: {
  readonly label: string;
  readonly count: number;
  readonly active: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
    >
      {label}
      <span className="text-muted-foreground">{count}</span>
    </button>
  );
}
