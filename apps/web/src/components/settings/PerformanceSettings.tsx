import { CircleIcon, CopyIcon, DownloadIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import {
  isPerfRecording,
  perfSnapshot,
  startPerfRecording,
  stopPerfRecording,
  subscribePerf,
} from "../../lib/perf/perfRecorder";
import {
  analyzePerfSession,
  formatMs,
  renderPerfReport,
  type PerfSeverity,
} from "../../lib/perf/perfSamples";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsSection, settingsPageShell } from "./settingsLayout";
import { cn } from "../../lib/utils";

/**
 * Record the app being slow, then read what was slow.
 *
 * The one performance surface: press record, do the thing that lags, press
 * stop, and the panel names what cost the time — panel bodies being rebuilt,
 * long tasks, stutters, slow interactions — worst first. Copy hands the same
 * thing over as markdown.
 */

const SEVERITY_TONE: Record<PerfSeverity, string> = {
  high: "text-rose-600 dark:text-rose-400",
  medium: "text-amber-600 dark:text-amber-400",
  low: "text-sky-600 dark:text-sky-400",
};

export function PerformanceSettingsPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const [tick, setTick] = useState(0);
  useEffect(() => subscribePerf(() => setTick((value) => value + 1)), []);

  const session = useMemo(() => perfSnapshot(), [tick]);
  const findings = useMemo(() => analyzePerfSession(session), [session]);
  const recording = isPerfRecording();
  const empty = session.samples.length === 0 && session.frames === 0;

  const toggle = useCallback(() => {
    if (isPerfRecording()) stopPerfRecording();
    else startPerfRecording();
    setTick((value) => value + 1);
  }, []);

  const copy = useCallback(() => {
    void writeTextToClipboard(renderPerfReport(perfSnapshot()), "performance report").then(
      () => toastManager.add({ title: "Performance report copied" }),
      (cause: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not copy the report",
          description: cause instanceof Error ? cause.message : String(cause),
        }),
    );
  }, []);

  const download = useCallback(() => {
    const blob = new Blob([renderPerfReport(perfSnapshot())], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "performance-report.md";
    link.click();
    URL.revokeObjectURL(url);
  }, []);

  return settingsPageShell(
    embedded,
    <>
      <SettingsSection
        title="Recording"
        headerAction={
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant={recording ? "destructive" : "default"}
              onClick={toggle}
              data-testid="perf-record"
            >
              {recording ? <SquareIcon className="size-3" /> : <CircleIcon className="size-3" />}
              {recording ? "Stop" : "Record"}
            </Button>
            <Button size="xs" variant="outline" disabled={empty} onClick={copy}>
              <CopyIcon className="size-3.5" />
              Copy report
            </Button>
            <Button size="xs" variant="outline" disabled={empty} onClick={download}>
              <DownloadIcon className="size-3.5" />
            </Button>
          </div>
        }
      >
        <div className="space-y-1 p-4 text-xs text-muted-foreground">
          <p>
            Press record, do the thing that lags — zoom the canvas, open a thread, run a turn — then
            stop. Nothing is measured while this is off.
          </p>
          <p className="font-mono text-[11px] text-foreground/70">
            {recording ? "recording · " : ""}
            {formatMs(session.durationMs)} · {session.frames} frames · {session.samples.length}{" "}
            samples
          </p>
          {session.notes.map((note) => (
            <p key={note} className="text-amber-600 dark:text-amber-400">
              {note}
            </p>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title={`Findings${findings.length > 0 ? ` (${findings.length})` : ""}`}>
        {findings.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">
            {empty
              ? "No recording yet."
              : "Nothing over threshold in this recording — no rebuilt panels, no long tasks, no stutters."}
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {findings.map((finding) => (
              <li key={finding.id} className="space-y-1 p-4">
                <p className="flex items-baseline gap-2 text-sm text-foreground">
                  <span
                    className={cn(
                      "shrink-0 text-[11px] font-semibold uppercase tracking-wide",
                      SEVERITY_TONE[finding.severity],
                    )}
                  >
                    {finding.severity}
                  </span>
                  <span className="min-w-0">{finding.title}</span>
                </p>
                <p className="text-xs text-muted-foreground">{finding.detail}</p>
                {finding.hint.length > 0 ? (
                  <p className="text-xs text-foreground/70">→ {finding.hint}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
    </>,
  );
}
