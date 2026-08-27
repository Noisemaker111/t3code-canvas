/**
 * In-process preview automation host backed by the server's headless Chromium.
 *
 * Registers with PreviewAutomationBroker exactly like the desktop app does, so
 * the existing preview_* MCP tools work for every agent thread on a plain web
 * deployment — no Electron required. Recording operations are not advertised;
 * the broker fails those loudly instead of degrading.
 *
 * @module AgentBrowserAutomationHost
 */
import {
  AGENT_BROWSER_DEFAULT_VIEWPORT,
  PreviewAutomationClickInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationPressInput,
  PreviewAutomationResizeInput,
  PreviewAutomationScrollInput,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
  PreviewTabId,
  type AgentBrowserSessionSummary,
  type PreviewAutomationOperation,
  type PreviewAutomationRequest,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
  type ThreadId,
} from "@t3tools/contracts";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Pw from "playwright-core";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as AgentBrowserManager from "./Manager.ts";

export const AGENT_BROWSER_HOST_CLIENT_ID = "t3-server-headless-browser";

/** Everything except the recording pair, which needs a compositor we don't have. */
const SUPPORTED_OPERATIONS: ReadonlyArray<PreviewAutomationOperation> = [
  "status",
  "open",
  "navigate",
  "snapshot",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "waitFor",
  "resize",
];

const VISIBLE_TEXT_LIMIT = 20_000;
const MAX_INTERACTIVE_ELEMENTS = 100;

class AgentBrowserHostInputError extends Schema.TaggedErrorClass<AgentBrowserHostInputError>()(
  "AgentBrowserHostInputError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Invalid ${this.operation} input for the server browser host`;
  }
}

const decode = <S extends Schema.Top>(schema: S, operation: string, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((cause) => new AgentBrowserHostInputError({ operation, cause })),
  );

interface ResponseError {
  readonly _tag: string;
  readonly message: string;
  readonly detail?: unknown;
}

function isPlaywrightTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function toResponseError(operation: string, error: unknown): ResponseError {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tagged = error as { _tag: string; message?: unknown; cause?: unknown };
    if (tagged._tag === "AgentBrowserSessionNotFoundError") {
      return { _tag: "PreviewAutomationTabNotFoundError", message: String(tagged.message ?? "") };
    }
    if (
      tagged._tag === "AgentBrowserUnavailableError" ||
      tagged._tag === "AgentBrowserLaunchError"
    ) {
      return { _tag: "PreviewAutomationUnavailableError", message: String(tagged.message ?? "") };
    }
    if (isPlaywrightTimeout(tagged.cause)) {
      return {
        _tag: "PreviewAutomationTimeoutError",
        message: (tagged.cause as Error).message,
      };
    }
    return {
      _tag: "PreviewAutomationExecutionError",
      message: String(tagged.message ?? `${operation} failed`),
    };
  }
  if (isPlaywrightTimeout(error)) {
    return { _tag: "PreviewAutomationTimeoutError", message: (error as Error).message };
  }
  return {
    _tag: "PreviewAutomationExecutionError",
    message: error instanceof Error ? error.message : `${operation} failed`,
  };
}

function statusFromSummary(summary: AgentBrowserSessionSummary | null): PreviewAutomationStatus {
  if (summary === null) {
    return {
      available: true,
      visible: false,
      tabId: null,
      url: null,
      title: null,
      loading: false,
    };
  }
  return {
    available: true,
    visible: true,
    tabId: summary.tabId,
    url: summary.url,
    title: summary.title,
    loading: summary.loading,
    viewport: { width: summary.viewport.width, height: summary.viewport.height },
  };
}

function targetLocator(page: Pw.Page, locator?: string, selector?: string): Pw.Locator | null {
  if (locator !== undefined) return page.locator(locator).first();
  if (selector !== undefined) return page.locator(`css=${selector}`).first();
  return null;
}

function resolveNavigateUrl(input: PreviewAutomationNavigateInput): string {
  if (input.url !== undefined) return input.url;
  const target = input.target;
  if (target === undefined) throw new Error("navigate requires url or target");
  if (target.kind === "url") return target.url;
  const protocol = target.protocol ?? "http";
  const path = target.path ?? "";
  return `${protocol}://127.0.0.1:${target.port}${path.startsWith("/") || path === "" ? path : `/${path}`}`;
}

interface SnapshotElement {
  tag: string;
  role: string | null;
  name: string;
  selector: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const collectInteractiveElements = (limit: number) => `
(() => {
  const selectors = "a[href], button, input, select, textarea, [role='button'], [role='link'], [role='tab'], [role='menuitem'], [role='checkbox'], [role='radio'], [role='combobox'], [contenteditable='true']";
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(selectors)) {
    if (out.length >= ${limit}) break;
    if (seen.has(el)) continue;
    seen.add(el);
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    let selector = el.tagName.toLowerCase();
    const testId = el.getAttribute("data-testid");
    if (testId) selector = "[data-testid='" + testId.replaceAll("'", "\\\\'") + "']";
    else if (el.id) selector = "#" + CSS.escape(el.id);
    else {
      const parent = el.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
        if (sameTag.length > 1) selector += ":nth-of-type(" + (sameTag.indexOf(el) + 1) + ")";
      }
    }
    const label = el.getAttribute("aria-label") || el.getAttribute("placeholder") || (el.textContent || "").trim().slice(0, 120) || el.getAttribute("name") || "";
    out.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      name: label,
      selector,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }
  return out;
})()`;

export const make = Effect.fn("AgentBrowserAutomationHost.make")(function* () {
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const manager = yield* AgentBrowserManager.AgentBrowserManager;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const crypto = yield* Crypto.Crypto;
  const environmentId = yield* serverEnvironment.getEnvironmentId;

  const openTab = Effect.fn("AgentBrowserAutomationHost.openTab")(function* (
    threadId: ThreadId,
    input: PreviewAutomationOpenInput,
    requestTabId: PreviewTabId | undefined,
  ) {
    if (input.reuseExistingTab === false) {
      const generated = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      return yield* manager.open({
        threadId,
        tabId: PreviewTabId.make(`tab-${generated}`),
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.profile === undefined ? {} : { profile: input.profile }),
      });
    }
    const tabId = input.tabId ?? requestTabId;
    return yield* manager.open({
      threadId,
      ...(tabId === undefined ? {} : { tabId }),
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.profile === undefined ? {} : { profile: input.profile }),
    });
  });

  const ensureTab = Effect.fn("AgentBrowserAutomationHost.ensureTab")(function* (
    threadId: ThreadId,
    tabId: PreviewTabId | undefined,
  ) {
    const current = yield* manager.currentTab(threadId);
    if (tabId !== undefined || current !== null) return tabId;
    yield* manager.open({ threadId });
    return undefined;
  });

  const buildSnapshot = (threadId: ThreadId, tabId: PreviewTabId | undefined) =>
    manager.usePage(
      threadId,
      tabId,
      "snapshot",
      async (handles): Promise<PreviewAutomationSnapshot> => {
        const { page, summary } = handles;
        const visibleText = (await page.evaluate(
          'document.body ? document.body.innerText : ""',
        )) as string;
        const interactiveElements = (await page.evaluate(
          collectInteractiveElements(MAX_INTERACTIVE_ELEMENTS),
        )) as Array<SnapshotElement>;
        const accessibilityTree = await page.locator("body").ariaSnapshot();
        const screenshotBuffer = await page.screenshot({ type: "png" });
        return {
          url: summary.url,
          title: summary.title,
          loading: summary.loading,
          visibleText: visibleText.slice(0, VISIBLE_TEXT_LIMIT),
          interactiveElements,
          accessibilityTree,
          consoleEntries: [...handles.consoleEntries],
          networkEntries: [...handles.networkEntries],
          actionTimeline: [],
          screenshot: {
            mimeType: "image/png",
            data: screenshotBuffer.toString("base64"),
            width: summary.viewport.width,
            height: summary.viewport.height,
          },
        };
      },
    );

  const handleOperation = Effect.fn("AgentBrowserAutomationHost.handleOperation")(function* (
    request: PreviewAutomationRequest,
  ) {
    const threadId = request.threadId;
    const requestTabId = request.tabId;
    const timeoutMs = request.timeoutMs;

    switch (request.operation) {
      case "status": {
        const current =
          requestTabId === undefined
            ? yield* manager.currentTab(threadId)
            : yield* manager
                .usePage(threadId, requestTabId, "status", async ({ summary }) => summary)
                .pipe(
                  Effect.catchTag("AgentBrowserSessionNotFoundError", () => Effect.succeed(null)),
                );
        return statusFromSummary(current);
      }
      case "open": {
        const input = yield* decode(PreviewAutomationOpenInput, "open", request.input);
        const summary = yield* openTab(threadId, input, requestTabId);
        return statusFromSummary(summary);
      }
      case "navigate": {
        const input = yield* decode(PreviewAutomationNavigateInput, "navigate", request.input);
        const url = resolveNavigateUrl(input);
        const tabId = yield* ensureTab(threadId, input.tabId ?? requestTabId);
        const waitUntil =
          input.readiness === "none"
            ? "commit"
            : input.readiness === "domContentLoaded"
              ? "domcontentloaded"
              : "load";
        yield* manager.usePage(threadId, tabId, "navigate", async ({ page }) => {
          await page.goto(url, {
            waitUntil,
            timeout: input.timeoutMs ?? timeoutMs,
          });
        });
        const summary = yield* manager.usePage(
          threadId,
          tabId,
          "status",
          async ({ summary: fresh }) => fresh,
        );
        return statusFromSummary(summary);
      }
      case "snapshot": {
        const input = yield* decode(
          Schema.Struct({ tabId: Schema.optional(PreviewTabId) }),
          "snapshot",
          request.input ?? {},
        );
        return yield* buildSnapshot(threadId, input.tabId ?? requestTabId);
      }
      case "click": {
        const input = yield* decode(PreviewAutomationClickInput, "click", request.input);
        yield* manager.usePage(threadId, input.tabId ?? requestTabId, "click", async ({ page }) => {
          const target = targetLocator(page, input.locator, input.selector);
          if (target !== null) {
            await target.click({ timeout: input.timeoutMs ?? timeoutMs });
          } else if (input.x !== undefined && input.y !== undefined) {
            await page.mouse.click(input.x, input.y);
          } else {
            throw new Error("click requires locator, selector, or x/y");
          }
        });
        return null;
      }
      case "type": {
        const input = yield* decode(PreviewAutomationTypeInput, "type", request.input);
        yield* manager.usePage(threadId, input.tabId ?? requestTabId, "type", async ({ page }) => {
          const target = targetLocator(page, input.locator, input.selector);
          if (target === null) {
            await page.keyboard.insertText(input.text);
            return;
          }
          if (input.clear === true) {
            await target.fill(input.text, { timeout: input.timeoutMs ?? timeoutMs });
            return;
          }
          await target.focus({ timeout: input.timeoutMs ?? timeoutMs });
          await page.keyboard.insertText(input.text);
        });
        return null;
      }
      case "press": {
        const input = yield* decode(PreviewAutomationPressInput, "press", request.input);
        yield* manager.usePage(threadId, input.tabId ?? requestTabId, "press", async ({ page }) => {
          const combo = [...(input.modifiers ?? []), input.key].join("+");
          await page.keyboard.press(combo);
        });
        return null;
      }
      case "scroll": {
        const input = yield* decode(PreviewAutomationScrollInput, "scroll", request.input);
        yield* manager.usePage(
          threadId,
          input.tabId ?? requestTabId,
          "scroll",
          async ({ page }) => {
            const deltaX = input.deltaX ?? 0;
            const deltaY = input.deltaY ?? 0;
            const target = targetLocator(page, input.locator, input.selector);
            if (target === null) {
              await page.mouse.wheel(deltaX, deltaY);
              return;
            }
            await target.evaluate(
              "(el, deltas) => { el.scrollBy(deltas.deltaX, deltas.deltaY); }",
              { deltaX, deltaY },
            );
          },
        );
        return null;
      }
      case "evaluate": {
        const input = yield* decode(PreviewAutomationEvaluateInput, "evaluate", request.input);
        return yield* manager.usePage(
          threadId,
          input.tabId ?? requestTabId,
          "evaluate",
          async ({ cdp }) => {
            const evaluated = await cdp.send("Runtime.evaluate", {
              expression: input.expression,
              awaitPromise: input.awaitPromise ?? true,
              returnByValue: input.returnByValue ?? true,
            });
            if (evaluated.exceptionDetails) {
              throw new Error(
                evaluated.exceptionDetails.exception?.description ??
                  evaluated.exceptionDetails.text,
              );
            }
            return evaluated.result.value ?? evaluated.result.description ?? null;
          },
        );
      }
      case "waitFor": {
        const input = yield* decode(PreviewAutomationWaitForInput, "waitFor", request.input);
        const timeout = input.timeoutMs ?? timeoutMs;
        yield* manager.usePage(
          threadId,
          input.tabId ?? requestTabId,
          "waitFor",
          async ({ page }) => {
            const target = targetLocator(page, input.locator, input.selector);
            if (target !== null) await target.waitFor({ state: "visible", timeout });
            if (input.text !== undefined) {
              await page.waitForFunction(
                "(needle) => Boolean(document.body && document.body.innerText.includes(needle))",
                input.text,
                { timeout },
              );
            }
            if (input.urlIncludes !== undefined) {
              await page.waitForFunction(
                "(needle) => window.location.href.includes(needle)",
                input.urlIncludes,
                { timeout },
              );
            }
          },
        );
        return null;
      }
      case "resize": {
        const input = yield* decode(PreviewAutomationResizeInput, "resize", request.input);
        const setting = resolvePreviewViewport(input);
        const size =
          setting._tag === "fill"
            ? { ...AGENT_BROWSER_DEFAULT_VIEWPORT }
            : { width: setting.width, height: setting.height };
        const summary = yield* manager.resizeViewport(threadId, input.tabId ?? requestTabId, size);
        return { tabId: summary.tabId, setting, viewport: size };
      }
      case "recordingStart":
      case "recordingStop": {
        return yield* new AgentBrowserHostInputError({
          operation: request.operation,
          cause: new Error("recording is not supported by the server browser host"),
        });
      }
    }
  });

  const handleRequest = Effect.fn("AgentBrowserAutomationHost.handleRequest")(function* (
    connectionId: string,
    request: PreviewAutomationRequest,
  ) {
    const response = yield* handleOperation(request).pipe(
      Effect.map((result) => ({
        clientId: AGENT_BROWSER_HOST_CLIENT_ID,
        connectionId,
        requestId: request.requestId,
        ok: true,
        result: result ?? null,
      })),
      Effect.catchCause((cause) =>
        Effect.succeed({
          clientId: AGENT_BROWSER_HOST_CLIENT_ID,
          connectionId,
          requestId: request.requestId,
          ok: false,
          error: toResponseError(request.operation, Cause.squash(cause)),
        }),
      ),
    );
    yield* broker.respond(response).pipe(Effect.ignoreCause({ log: true }));
  });

  const events = yield* broker.connect({
    clientId: AGENT_BROWSER_HOST_CLIENT_ID,
    environmentId,
    supportedOperations: SUPPORTED_OPERATIONS,
  });

  yield* events.pipe(
    Stream.runForEach((event) =>
      event.type === "request"
        ? Effect.forkScoped(handleRequest(event.connectionId, event.request))
        : Effect.void,
    ),
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(make());
