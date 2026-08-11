/**
 * The board chip's one line about the Hermes loop.
 *
 * The old chip said "starting" whenever a beat was older than the interval,
 * which is what a long tick looks like — so a healthy loop read as if it kept
 * restarting. Nothing here infers state from a stale timestamp: busy, next tick
 * and failures come from the loop itself.
 */
import type { HermesBoardStatus } from "@t3tools/contracts";

export type HermesChipTone = "good" | "working" | "warn" | "bad";

export type HermesChipState = {
  readonly label: string;
  readonly detail: string | null;
  readonly tone: HermesChipTone;
  readonly title: string;
};

/** Seconds of slack before a scheduled tick counts as late rather than due. */
const LATE_AFTER_MS = 20_000;

function countdown(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

function clip(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Composer receipt: send answers "when does Hermes get this?" on the spot. */
export function describeCapturePickup(status: HermesBoardStatus | null): string {
  if (!status || !status.enabled) {
    return "Hermes is off — the card waits in Prompts until you launch it or turn Hermes on.";
  }
  if (status.pipelineIdle) {
    return "Hermes is on but its structure → Active policies are off, so it will leave this card alone.";
  }
  // Sending wakes the loop; there is no countdown left to quote.
  if (status.busy) return "Hermes is mid-tick; it picks this up the moment that one finishes.";
  return "Hermes picks this up now.";
}

export function describeHermesChip(status: HermesBoardStatus, nowMs: number): HermesChipState {
  if (status.pipelineIdle) {
    return {
      label: "Hermes idle",
      detail: "no automation on",
      tone: "warn",
      title:
        "Hermes is on but structure → Active are all off, so it ticks and moves nothing. Settings → Board → Hermes automation.",
    };
  }

  // Before anything about ticks: a selection with no transport fails every one
  // of them, and on a quiet board no tick runs to say so.
  if (status.providerError) {
    return {
      label: "Hermes has no provider",
      detail: clip(status.providerError),
      tone: "bad",
      title: `${status.providerError}. Settings → Hermes → Board brain model.`,
    };
  }

  if (status.busy) {
    return {
      label: "Hermes working",
      detail: status.lastTier ? `on ${status.lastTier}` : null,
      tone: "working",
      title: "A tick is running right now. Cards in the snapshot are being decided.",
    };
  }

  if (status.consecutiveFailures > 0 && status.lastError) {
    return {
      label:
        status.consecutiveFailures === 1
          ? "Hermes tick failed"
          : `Hermes failing ×${status.consecutiveFailures}`,
      detail: clip(status.lastError),
      tone: "bad",
      title: `Last tick failed: ${status.lastError}. Settings → Hermes has "Retry tick"; the Tick log has the transcript.`,
    };
  }

  if (status.lastHeartbeatAt !== null && status.lastSkipReason !== null) {
    const dueInMs = status.nextTickAt === null ? NaN : Date.parse(status.nextTickAt) - nowMs;
    const dueDetail = Number.isFinite(dueInMs)
      ? `next ${countdown(Math.max(0, dueInMs))}`
      : "model idle";
    // A failing box check blocks every tick until it is fixed — that is not
    // the same "watching" as an idle board with nothing to do, and showing it
    // in the same green tone read as the loop working when it was stuck.
    if (status.lastSkipIsBoxBlock) {
      return {
        label: "Hermes blocked",
        detail: clip(status.lastSkipReason),
        tone: "bad",
        title: `${status.lastSkipReason} Settings → System has "Run checks & fix".`,
      };
    }
    // A PR still needing reconciliation is not a healthy idle board — green
    // "watching" made stuck merges look fine.
    const skip = status.lastSkipReason;
    const prStuck = /pull request card needs reconciliation/i.test(skip);
    return {
      label: prStuck ? "Hermes stuck on PR" : "Hermes watching",
      detail: dueDetail,
      tone: prStuck ? "warn" : "good",
      title: `Last check skipped: ${skip}`,
    };
  }

  if (!status.running || status.nextTickAt === null) {
    return {
      label: "Hermes not ticking",
      detail: null,
      tone: "warn",
      title: "The switch is on but no tick is scheduled. Settings → Hermes → Run now.",
    };
  }

  const dueInMs = Date.parse(status.nextTickAt) - nowMs;
  if (Number.isFinite(dueInMs) && dueInMs < -LATE_AFTER_MS) {
    return {
      label: "Hermes late",
      detail: `${countdown(-dueInMs)} overdue`,
      tone: "warn",
      title: "The scheduled tick has not fired. The previous one may still be finishing.",
    };
  }

  return {
    label: status.lastBeatAt === null ? "Hermes ready" : "Hermes live",
    detail: `next ${countdown(Math.max(0, dueInMs))}`,
    tone: "good",
    title:
      status.lastBeatAt === null
        ? "Hermes is on and waiting for its first tick."
        : `Last tick ${status.lastSummary ?? "ok"}.`,
  };
}
