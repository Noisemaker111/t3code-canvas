/**
 * Fix it — turn an error the app already caught into a task an agent can act
 * on, without leaving the app. One builder feeds every surface: the copy
 * button in the error log, the Fix it button on an error toast, and the card
 * or host thread `useFixError` opens.
 *
 * @module fixIt
 */
import { APP_VERSION, BUILD_SHA } from "../branding";

/** The shape every error surface already has: a title, a body, a time. */
export interface FixItError {
  readonly title: string;
  readonly description: string;
  readonly timestamp: number;
}

export interface FixItContext {
  readonly href: string;
  readonly version: string;
  readonly buildSha: string;
}

/** Read the browser-side context the prompt carries. */
export function currentFixItContext(): FixItContext {
  return {
    href: typeof window === "undefined" ? "" : window.location.href,
    version: APP_VERSION,
    buildSha: BUILD_SHA,
  };
}

function formatError(error: FixItError): string {
  const time = new Date(error.timestamp).toISOString();
  return `[${time}] ${error.title}\n${error.description}`;
}

/**
 * Where an agent on the box reads the rest of the story. Client errors are
 * POSTed to `/api/client-errors`, which writes both logs below.
 */
const WHERE_TO_LOOK = [
  "Where to look on the box:",
  "- Server log: journalctl -u t3j -n 300 --no-pager",
  "- Health incidents: curl -s localhost:3000/api/health/incidents",
  "- Web app source: vendor/t3code/apps/web, server: vendor/t3code/apps/server",
];

/** The whole prompt: what broke, where it broke, where the logs are, what to do. */
export function fixItPrompt(
  errors: ReadonlyArray<FixItError>,
  context: FixItContext = currentFixItContext(),
): string {
  const oldestFirst = errors.toReversed();
  const body =
    oldestFirst.length === 1
      ? formatError(oldestFirst[0]!)
      : oldestFirst.map((error, index) => `${index + 1}. ${formatError(error)}`).join("\n\n");

  return [
    oldestFirst.length === 1
      ? "Fix this error from the T3 Code app."
      : `Fix these ${oldestFirst.length} errors from the T3 Code app.`,
    "",
    body,
    "",
    `URL: ${context.href}`,
    `Version: ${context.version} (build ${context.buildSha})`,
    "",
    ...WHERE_TO_LOOK,
    "",
    "Find the root cause, fix it, and say what changed.",
  ].join("\n");
}

const CARD_TITLE_MAX = 120;

/** Card/thread title: the error's own words, so the board reads as the error list. */
export function fixItTitle(errors: ReadonlyArray<FixItError>): string {
  const first = errors[0];
  if (!first) return "Fix an app error";
  const rest = errors.length - 1;
  const suffix = rest > 0 ? ` (+${rest} more)` : "";
  const head = first.title.trim().replace(/\s+/gu, " ") || "app error";
  const room = CARD_TITLE_MAX - "Fix: ".length - suffix.length;
  const clipped = head.length > room ? `${head.slice(0, room - 1).trimEnd()}…` : head;
  return `Fix: ${clipped}${suffix}`;
}
