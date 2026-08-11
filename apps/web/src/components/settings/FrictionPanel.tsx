import { BandageIcon, CheckIcon, ChevronRightIcon, CopyIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import {
  fetchFriction,
  setFrictionStatus,
  FRICTION_SOURCE_LABELS,
  FRICTION_STATUS_LABELS,
  type FrictionEntry,
  type FrictionStatus,
} from "../../lib/friction";
import {
  readBoardSettings,
  subscribeBoardSettings,
  updateBoardSettings,
  type BoardSettings,
} from "../../lib/boardSettings";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection, settingsPageShell } from "./settingsLayout";

const POLL_MS = 15_000;

const SCOPE_TONE: Record<string, string> = {
  upstream: "text-amber-600 dark:text-amber-400",
  harness: "text-sky-600 dark:text-sky-400",
  repo: "text-violet-600 dark:text-violet-400",
  env: "text-emerald-600 dark:text-emerald-400",
};

const STATUS_TONE: Record<FrictionStatus, string> = {
  open: "text-foreground",
  carded: "text-muted-foreground",
  fixed: "text-muted-foreground line-through",
  wontfix: "text-muted-foreground line-through",
};

function clockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString(undefined, { hour12: false });
}

function stamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** One entry as a paste-ready block — what a human hands to an agent or an issue. */
function entryText(entry: FrictionEntry): string {
  const lines = [
    `[${entry.scope}] ${entry.tool} ×${entry.count} — ${FRICTION_STATUS_LABELS[entry.status]}`,
    entry.summary,
    `${FRICTION_SOURCE_LABELS[entry.source]} · first ${stamp(entry.firstSeenAt)} · last ${stamp(entry.lastSeenAt)}`,
  ];
  if (entry.threadIds.length > 0) lines.push(`threads: ${entry.threadIds.join(", ")}`);
  if (entry.evidence) lines.push("evidence:", entry.evidence);
  if (entry.workaround) lines.push(`workaround: ${entry.workaround}`);
  lines.push(`fingerprint: ${entry.fingerprint}`);
  return lines.join("\n");
}

/** Summaries usually open with the tool name the row already prints. */
function trimTool(summary: string, tool: string): string {
  const trimmed = summary.startsWith(`${tool} `) ? summary.slice(tool.length + 1) : summary;
  return trimmed.length > 0 ? trimmed : summary;
}

function CopyButton({ label, text, children }: { label: string; text: string; children?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void writeTextToClipboard(text, "papercut").then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1_500);
      },
      (cause: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not copy",
          description: cause instanceof Error ? cause.message : String(cause),
        });
      },
    );
  }, [text]);
  return (
    <Button
      size={children ? "xs" : "icon-xs"}
      variant="ghost"
      aria-label={label}
      title={label}
      onClick={copy}
    >
      {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      {children}
    </Button>
  );
}

function LogRow({
  entry,
  busy,
  onMark,
}: {
  entry: FrictionEntry;
  busy: boolean;
  onMark: (entry: FrictionEntry, status: FrictionStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const detail = Boolean(entry.evidence || entry.workaround || entry.threadIds.length > 0);
  return (
    <div className="border-t border-border/60 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2 px-2 py-1 font-mono text-[11px] leading-5 hover:bg-muted/40">
        <button
          type="button"
          disabled={!detail}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-64 flex-1 items-center gap-2 text-left disabled:cursor-default"
        >
          <ChevronRightIcon
            className={`size-3 shrink-0 text-muted-foreground/60 transition-transform ${open ? "rotate-90" : ""} ${detail ? "" : "invisible"}`}
          />
          <span
            className="shrink-0 tabular-nums text-muted-foreground/70"
            title={stamp(entry.lastSeenAt)}
          >
            {clockTime(entry.lastSeenAt)}
          </span>
          <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">
            {entry.count}×
          </span>
          <span className={`w-16 shrink-0 ${SCOPE_TONE[entry.scope] ?? "text-muted-foreground"}`}>
            {entry.scope}
          </span>
          <span className="shrink-0 font-medium text-foreground/80">{entry.tool}</span>
          <span className={`truncate ${STATUS_TONE[entry.status]}`}>
            {trimTool(entry.summary, entry.tool)}
          </span>
        </button>
        <span className="w-16 shrink-0 whitespace-nowrap text-right text-[10px] uppercase tracking-wide text-muted-foreground/70">
          {entry.status === "open" ? "" : FRICTION_STATUS_LABELS[entry.status]}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <CopyButton label={`Copy the ${entry.tool} papercut`} text={entryText(entry)} />
          <Button
            size="xs"
            variant="ghost"
            disabled={busy || entry.status === "fixed"}
            onClick={() => onMark(entry, "fixed")}
          >
            Fixed
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy || entry.status === "wontfix"}
            onClick={() => onMark(entry, "wontfix")}
          >
            Won't fix
          </Button>
        </div>
      </div>
      {open && detail ? (
        <div className="space-y-1.5 px-2 pb-2.5 pl-9 font-mono text-[11px] text-muted-foreground">
          <div>
            {FRICTION_SOURCE_LABELS[entry.source]} · first {stamp(entry.firstSeenAt)} · last{" "}
            {stamp(entry.lastSeenAt)}
            {entry.threadIds.length > 0 ? ` · threads ${entry.threadIds.join(", ")}` : ""}
          </div>
          {entry.evidence ? (
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/60 px-2.5 py-1.5">
              {entry.evidence}
            </pre>
          ) : null}
          {entry.workaround ? <div>worked around by: {entry.workaround}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function FrictionPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const [entries, setEntries] = useState<ReadonlyArray<FrictionEntry>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [board, setBoard] = useState<BoardSettings>(() => readBoardSettings());
  useEffect(() => subscribeBoardSettings(setBoard), []);

  const load = useCallback(async () => {
    try {
      const result = await fetchFriction();
      setEntries(result.entries);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the friction log.");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const mark = useCallback(
    async (entry: FrictionEntry, status: FrictionStatus) => {
      setBusy(true);
      try {
        await setFrictionStatus(entry.fingerprint, status);
        await load();
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: "Could not update the papercut",
          description: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const openCount = entries.filter((entry) => entry.status === "open").length;
  const allText = useMemo(() => entries.map(entryText).join("\n\n"), [entries]);

  return settingsPageShell(
    embedded,
    <>
      <SettingsSection
        title="Papercuts"
        icon={<BandageIcon className="size-3.5" />}
        headerAction={
          <div className="flex items-center gap-0.5">
            {entries.length > 0 ? (
              <CopyButton label="Copy every papercut" text={allText}>
                Copy all
              </CopyButton>
            ) : null}
            <Button size="icon-xs" variant="ghost" aria-label="Refresh" onClick={() => void load()}>
              <RefreshCwIcon className="size-3.5" />
            </Button>
          </div>
        }
      >
        <SettingsRow
          title="Auto-draft a fix card"
          description="File a Draft when a papercut hits 3 sightings, or 2 from different threads. Off means the log is yours to read."
          control={
            <Switch
              checked={board.hermesAutoDraftPapercuts}
              onCheckedChange={(checked) =>
                setBoard(
                  updateBoardSettings({
                    hermesAutoDraftPapercuts: Boolean(checked),
                  }),
                )
              }
            />
          }
        />
        <div className="border-t border-border/60">
          {error ? (
            <p className="px-4 py-3 text-xs text-destructive sm:px-5">{error}</p>
          ) : entries.length === 0 ? (
            <p className="px-4 py-3 text-xs text-muted-foreground sm:px-5">
              Empty. Agents call kanban_papercut when they work around a broken tool, and a detector
              files the ones they never mention.
            </p>
          ) : (
            <>
              <div className="px-2 py-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
                {entries.length} logged · {openCount} open
              </div>
              <div className="border-t border-border/60">
                {entries.map((entry) => (
                  <LogRow key={entry.fingerprint} entry={entry} busy={busy} onMark={mark} />
                ))}
              </div>
            </>
          )}
        </div>
      </SettingsSection>
    </>,
  );
}
