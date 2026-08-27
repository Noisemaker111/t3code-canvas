/**
 * A crashed web app must leave a trail. The crash screen shows the details
 * inline and offers a paste-ready report for an agent; `reportCrash` also puts
 * the crash in the browser console, the session error log, and — via
 * `POST /api/client-errors` — the server log and health incident log, so an
 * agent on the box can read it without a screenshot.
 *
 * @module crashReport
 */
import { APP_VERSION, BUILD_SHA } from "./branding";
import { useErrorLogStore } from "./components/ui/errorLogStore";
import { readDesktopPrimaryBearerToken } from "./environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "./environments/primary/target";

export interface CrashReport {
  readonly message: string;
  readonly details: string;
  readonly href: string;
  readonly at: string;
  readonly version: string;
  readonly buildSha: string;
}

export function crashMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

export function crashDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}

export function buildCrashReport(error: unknown): CrashReport {
  return {
    message: crashMessage(error),
    details: crashDetails(error),
    href: typeof window === "undefined" ? "" : window.location.href,
    at: new Date().toISOString(),
    version: APP_VERSION,
    buildSha: BUILD_SHA,
  };
}

/** The clipboard payload of the crash screen's copy button: paste it to an agent as-is. */
export function formatCrashReportForAgent(report: CrashReport): string {
  return [
    "The T3 Code web app crashed and showed its error screen. Please investigate and fix it:",
    "",
    `Message: ${report.message}`,
    `URL: ${report.href}`,
    `Time: ${report.at}`,
    `Version: ${report.version} (build ${report.buildSha})`,
    "",
    "Details:",
    report.details,
  ].join("\n");
}

const reportedCrashKeys = new Set<string>();

/**
 * Console + session error log + server, once per distinct crash. Error
 * boundaries re-render, so the same error must not report twice.
 */
export function reportCrash(report: CrashReport): void {
  const key = `${report.message}\n${report.details}`;
  if (reportedCrashKeys.has(key)) return;
  reportedCrashKeys.add(key);

  console.error("[crash] Web app crashed", {
    message: report.message,
    href: report.href,
    details: report.details,
  });

  useErrorLogStore.getState().addEntry({
    id: `crash:${report.at}`,
    title: "Web app crashed",
    description: report.message,
  });

  void postCrashToServer(report);
}

async function postCrashToServer(report: CrashReport): Promise<void> {
  try {
    const url = resolvePrimaryEnvironmentHttpUrl("/api/client-errors");
    const bearerToken = await readDesktopPrimaryBearerToken().catch(() => null);
    const response = await fetch(url, {
      method: "POST",
      credentials: bearerToken === null ? "include" : "omit",
      headers: {
        "content-type": "application/json",
        ...(bearerToken === null ? {} : { authorization: `Bearer ${bearerToken}` }),
      },
      body: JSON.stringify(report),
    });
    if (!response.ok) {
      throw new Error(`POST /api/client-errors responded ${response.status}`);
    }
  } catch (cause) {
    // The crash screen already shows the details inline; console is the only surface left.
    console.error("[crash] Could not report the crash to the server", cause);
  }
}
