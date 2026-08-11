import Mime from "@effect/platform-node/Mime";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { boardRulePolicy, hermesPipelinePatch } from "@t3tools/shared/boardRules";
import { decodeOtlpTraceRecords } from "@t3tools/shared/observability";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { cast } from "effect/Function";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
  HttpServerRespondable,
} from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { OtlpTracer } from "effect/unstable/observability";

import * as ServerConfig from "./config.ts";
import { ASSET_ROUTE_PREFIX, resolveAsset } from "./assets/AssetAccess.ts";
import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { traceRelayRequest } from "./cloud/traceRelayRequest.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentScopeRequired,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
} from "./auth/http.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { browserApiCorsAllowedHeaders, browserApiCorsAllowedMethods } from "./httpCors.ts";
import { getUsageService, isStoredCredentialProvider } from "./usage/UsageService.ts";
import { getOpenRouterCatalog } from "./kanban/OpenRouterModelCatalog.ts";
import { runModelBenchBatch } from "./kanban/ModelBenchRunner.ts";
import { ServerSettingsService } from "./serverSettings.ts";
import { modelRouteFacts } from "./kanban/modelEvidence.ts";
import { readBudgetStore } from "./kanban/budget/budgetStore.ts";
import type { HermesTier } from "@t3tools/contracts";
import { listFriction, setFrictionStatus } from "./friction/frictionStore.ts";
import { listLessons, recordLesson, retireLesson } from "./kanban/hermes/knowledgeStore.ts";
import { readHealthIncidents, recordHealthReport } from "./health/incidentLog.ts";
import {
  checkPurgeConfirmation,
  isMaintenanceTargetId,
  purgeMaintenanceTarget,
  surveyMaintenance,
  surveyMaintenanceTarget,
  MAINTENANCE_TARGET_IDS,
} from "./maintenance/Maintenance.ts";
import {
  hermesBoardStatus,
  hermesBrainStatus,
  hermesConversationStatus,
  hermesTickById,
  resetHermesConversation,
  runOneTick,
  type HermesBrainDeps,
} from "./kanban/hermes/HermesBrain.ts";
import {
  applyHermesBrainSwitch,
  getHermesBrainDeps,
  getHermesBudgetDeps,
} from "./kanban/hermes/HermesBrainLayer.ts";
import { hermesChatEntries } from "./kanban/hermes/chatStore.ts";
import {
  buildPlanForText,
  getBudgetStatus,
  refreshBudgetMeasurements,
  type BudgetDeps,
} from "./kanban/budget/BudgetService.ts";
import { clampBudgetPosition } from "./kanban/budget/knobs.ts";
import { formatBudgetPlan } from "./kanban/budget/plan.ts";
import {
  generateCanvasImage,
  isCanvasImageBackground,
  isCanvasImageMediaType,
  OpenAiImageError,
  removeCanvasImageBackground,
} from "./canvas/openaiImages.ts";

const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const DESKTOP_RENDERER_ORIGINS = ["t3code://app", "t3code-dev://app"];
const usageService = getUsageService();

export const browserApiCorsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const devOrigin = config.devUrl?.origin;
    // Dev uses credentialed requests from Vite or the Electron custom origin, so both must be
    // explicit. Packaged desktop omits credentials and uses Effect's default wildcard origin.
    return HttpRouter.cors({
      ...(devOrigin
        ? { allowedOrigins: [devOrigin, ...DESKTOP_RENDERER_ORIGINS], credentials: true }
        : {}),
      allowedMethods: browserApiCorsAllowedMethods,
      allowedHeaders: browserApiCorsAllowedHeaders,
      maxAge: 600,
    });
  }),
);

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

const authenticateRawRouteWithScope = (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(scope)) {
      return yield* failEnvironmentScopeRequired(scope);
    }
  });

export const serverEnvironmentHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "metadata",
  Effect.fnUntraced(function* (handlers) {
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    return handlers.handle(
      "descriptor",
      Effect.fn("environment.metadata.descriptor")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        return yield* serverEnvironment.getDescriptor;
      }, traceRelayRequest),
    );
  }),
);

class DecodeOtlpTraceRecordsError extends Data.TaggedError("DecodeOtlpTraceRecordsError")<{
  readonly cause: unknown;
  readonly bodyJson: OtlpTracer.TraceData;
}> {}

export const otlpTracesProxyRouteLayer = HttpRouter.add(
  "POST",
  OTLP_TRACES_PROXY_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig.ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const browserTraceCollector = yield* BrowserTraceCollector.BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const bodyJson = cast<unknown, OtlpTracer.TraceData>(yield* request.json);

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => new DecodeOtlpTraceRecordsError({ cause, bodyJson }),
    }).pipe(
      Effect.flatMap((records) => browserTraceCollector.record(records)),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to decode browser OTLP traces", {
          cause,
          bodyJson,
        }),
      ),
    );

    if (otlpTracesUrl === undefined) {
      return HttpServerResponse.empty({ status: 204 });
    }

    return yield* httpClient
      .post(otlpTracesUrl, {
        body: HttpBody.jsonUnsafe(bodyJson),
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.as(HttpServerResponse.empty({ status: 204 })),
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to export browser OTLP traces", {
            cause,
            otlpTracesUrl,
          }),
        ),
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("Trace export failed.", { status: 502 }),
        ),
      );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const assetRouteLayer = HttpRouter.add(
  "GET",
  `${ASSET_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const suffix = url.value.pathname.slice(`${ASSET_ROUTE_PREFIX}/`.length);
    const separatorIndex = suffix.indexOf("/");
    if (separatorIndex <= 0) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const asset = yield* resolveAsset(
      suffix.slice(0, separatorIndex),
      suffix.slice(separatorIndex + 1),
    );
    if (!asset) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    return yield* HttpServerResponse.file(asset.path, {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    }).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }),
);

// This route intentionally exposes only normalized limit snapshots. Credential files are read on the
// server under the same account that runs the provider CLIs and never cross the HTTP boundary.
export const usageRouteLayer = HttpRouter.add(
  "GET",
  "/api/usage",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const force = Option.isSome(url) && url.value.searchParams.get("force") === "1";
    const usage = yield* Effect.promise(() => usageService.getUsageSafe({ force }));
    // jsonUnsafe, not json: `HttpServerResponse.json` returns an Effect, and returning that
    // unexecuted Effect from the route made the router write no response at all — every
    // authenticated /api/usage request hung forever while unauthenticated 401s worked.
    return HttpServerResponse.jsonUnsafe(usage, {
      headers: { "Cache-Control": "private, max-age=30" },
    });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/** Which source feeds each usage family's credential — labels only, no secrets. */
export const usageCredentialsRouteLayer = HttpRouter.add(
  "GET",
  "/api/usage/credentials",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const credentials = yield* Effect.promise(() => usageService.credentialStatuses());
    return HttpServerResponse.jsonUnsafe(
      { credentials },
      { headers: { "Cache-Control": "no-store" } },
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/** Set (token string) or clear (token null) a pasted usage token for a family. */
export const usageCredentialsWriteRouteLayer = HttpRouter.add(
  "POST",
  "/api/usage/credentials",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rawBody = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const body = asJsonObject(rawBody);
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const token =
      typeof body.token === "string" && body.token.trim().length > 0 ? body.token : null;
    if (!isStoredCredentialProvider(provider)) {
      return HttpServerResponse.jsonUnsafe(
        { error: "provider must be one of: cursor, grok, openrouter" },
        { status: 400 },
      );
    }
    yield* Effect.promise(() => usageService.setStoredCredential(provider, token));
    const credentials = yield* Effect.promise(() => usageService.credentialStatuses());
    return HttpServerResponse.jsonUnsafe(
      { credentials },
      { headers: { "Cache-Control": "no-store" } },
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

function asJsonObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** OpenRouter pricing/context catalog for Board model-bench (cached ~30m). */
export const modelBenchCatalogRouteLayer = HttpRouter.add(
  "GET",
  "/api/model-bench/catalog",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const catalog = yield* Effect.promise(() => getOpenRouterCatalog());
    return HttpServerResponse.jsonUnsafe(
      {
        entries: catalog.entries,
        ...(catalog.error ? { error: catalog.error } : {}),
      },
      { headers: { "Cache-Control": "private, max-age=300" } },
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/**
 * `/api/models/facts` — the sourced facts for every route on the roster.
 *
 * Same assembler Hermes reads, so the settings roster and the router can never
 * describe a model differently. Unknown fields stay null; nothing is inferred
 * from a model name.
 */
export const modelRouteFactsRouteLayer = HttpRouter.add(
  "GET",
  "/api/models/facts",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const serverSettings = yield* ServerSettingsService;
    const settings = yield* serverSettings.getSettings;
    // The roster, plus every route this box has actually run: the model picker
    // shows more models than the router seats, and a picker row with no facts
    // is what a name-shaped guess used to fill.
    const seats = (settings.boardSettings.modelRoster ?? []).map((entry) => ({
      instanceId: String(entry.instanceId),
      model: entry.model,
    }));
    const observed = readBudgetStore().samples.map((sample) => ({
      instanceId: sample.harness,
      model: sample.model,
    }));
    const routes = [
      ...new Map([...seats, ...observed].map((r) => [`${r.instanceId}::${r.model}`, r])).values(),
    ];
    const facts = yield* Effect.promise(() => modelRouteFacts(routes));
    return HttpServerResponse.jsonUnsafe({ facts }, { headers: { "Cache-Control": "no-store" } });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/**
 * Run model-bench fixtures against selected OpenRouter models.
 * Default fixture: structure (voice ramble → mission). Optional dual orch+hermes.
 * Streams OpenRouter for TTFT, completion time, usage tokens, and list-price cost.
 */
export const modelBenchRunRouteLayer = HttpRouter.add(
  "POST",
  "/api/model-bench/run",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rawBody = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const body = asJsonObject(rawBody);
    const rawCandidates = Array.isArray(body.candidates) ? body.candidates : [];
    const candidates = rawCandidates
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const r = row as Record<string, unknown>;
        const instanceId = typeof r.instanceId === "string" ? r.instanceId.trim() : "";
        const model = typeof r.model === "string" ? r.model.trim() : "";
        if (!instanceId || !model) return null;
        return {
          instanceId,
          model,
          ...(typeof r.label === "string" ? { label: r.label } : {}),
        };
      })
      .filter((c): c is { instanceId: string; model: string; label?: string } => c !== null)
      .slice(0, 12);

    if (candidates.length === 0) {
      return HttpServerResponse.jsonUnsafe(
        { error: "candidates required (max 12)" },
        { status: 400 },
      );
    }

    const rolesRaw = Array.isArray(body.roles) ? body.roles : ["structure"];
    const roles = rolesRaw.filter(
      (r): r is "hermes" | "structure" => r === "hermes" || r === "structure",
    );
    const trials = yield* Effect.promise(() =>
      runModelBenchBatch({
        candidates,
        roles: roles.length > 0 ? roles : ["structure"],
      }),
    );
    return HttpServerResponse.jsonUnsafe({ trials }, { headers: { "Cache-Control": "no-store" } });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

const openAiImageErrorStatus = (error: OpenAiImageError): number => {
  switch (error.kind) {
    case "bad-input":
      return 400;
    case "no-key":
      return 409;
    default:
      return 502;
  }
};

async function canvasImagePayloadResponse(run: () => Promise<{ mediaType: string; data: string }>) {
  try {
    const image = await run();
    return HttpServerResponse.jsonUnsafe({ image }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    if (cause instanceof OpenAiImageError) {
      return HttpServerResponse.jsonUnsafe(
        { error: cause.message },
        { status: openAiImageErrorStatus(cause) },
      );
    }
    return HttpServerResponse.jsonUnsafe(
      { error: cause instanceof Error ? cause.message : "image request failed" },
      { status: 500 },
    );
  }
}

const canvasImageResponse = (run: () => Promise<{ mediaType: string; data: string }>) =>
  Effect.promise(() => canvasImagePayloadResponse(run));

/** Prompt → PNG via OpenAI `gpt-image-1`, for placing on the canvas. */
export const canvasImageGenerateRouteLayer = HttpRouter.add(
  "POST",
  "/api/canvas/image/generate",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rawBody = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const body = asJsonObject(rawBody);
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    const background = isCanvasImageBackground(body.background) ? body.background : "auto";
    return yield* canvasImageResponse(() => generateCanvasImage({}, { prompt, background }));
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/** Canvas image → same subject on a transparent PNG (OpenAI image edit). */
export const canvasImageRemoveBackgroundRouteLayer = HttpRouter.add(
  "POST",
  "/api/canvas/image/remove-background",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rawBody = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const body = asJsonObject(rawBody);
    const image = asJsonObject(body.image);
    const mediaType = image.mediaType;
    const data = typeof image.data === "string" ? image.data : "";
    if (!isCanvasImageMediaType(mediaType) || data.length === 0) {
      return HttpServerResponse.jsonUnsafe(
        { error: "image must be { mediaType: image/png|jpeg|webp, data: base64 }" },
        { status: 400 },
      );
    }
    return yield* canvasImageResponse(() =>
      removeCanvasImageBackground({}, { image: { mediaType, data } }),
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/**
 * Proxy skills.sh / GitHub raw fetches so the browser is not blocked by CORS
 * (common when the web UI runs on Vite localhost against a remote API).
 */
export const skillsShSearchRouteLayer = HttpRouter.add(
  "GET",
  "/api/skills-sh/search",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const q = Option.isSome(url) ? (url.value.searchParams.get("q") ?? "").trim() : "";
    if (q.length === 0) {
      return HttpServerResponse.jsonUnsafe({ query: "", skills: [] });
    }
    const upstream = `https://www.skills.sh/api/search?q=${encodeURIComponent(q)}`;
    const httpClient = yield* HttpClient.HttpClient;
    return yield* httpClient.get(upstream, { headers: { Accept: "application/json" } }).pipe(
      Effect.flatMap((response) =>
        Effect.map(response.text, (bodyText) =>
          HttpServerResponse.text(bodyText, {
            status: response.status,
            headers: {
              "Content-Type": response.headers["content-type"] ?? "application/json",
              "Cache-Control": "private, max-age=60",
            },
          }),
        ),
      ),
      Effect.tapError((cause) => Effect.logWarning("skills.sh search failed", { cause, upstream })),
      Effect.orElseSucceed(() =>
        HttpServerResponse.jsonUnsafe({ error: "Upstream search failed" }, { status: 502 }),
      ),
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

const ALLOWED_SKILL_MD_HOSTS = new Set(["raw.githubusercontent.com", "www.skills.sh", "skills.sh"]);

export const skillsShFetchRouteLayer = HttpRouter.add(
  "GET",
  "/api/skills-sh/fetch",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const target = Option.isSome(url) ? (url.value.searchParams.get("url") ?? "").trim() : "";
    if (target.length === 0) {
      return HttpServerResponse.text("Missing url", { status: 400 });
    }
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      return HttpServerResponse.text("Invalid url", { status: 400 });
    }
    if (parsed.protocol !== "https:" || !ALLOWED_SKILL_MD_HOSTS.has(parsed.hostname)) {
      return HttpServerResponse.text("Host not allowed", { status: 400 });
    }
    const upstreamUrl = parsed.toString();
    const httpClient = yield* HttpClient.HttpClient;
    return yield* httpClient.get(upstreamUrl, { headers: { Accept: "text/plain,*/*" } }).pipe(
      Effect.flatMap((response) =>
        Effect.map(response.text, (bodyText) =>
          HttpServerResponse.text(bodyText, {
            status: response.status,
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "private, max-age=120",
            },
          }),
        ),
      ),
      Effect.tapError((cause) =>
        Effect.logWarning("skills.sh fetch failed", { cause, url: upstreamUrl }),
      ),
      Effect.orElseSucceed(() => HttpServerResponse.text("Upstream fetch failed", { status: 502 })),
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig.ServerConfig;
    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    const staticDir =
      config.staticDir ?? (config.devUrl ? yield* ServerConfig.resolveStaticDir() : undefined);
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    const fileInfo = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!fileInfo || fileInfo.type !== "File") {
      const indexPath = path.resolve(staticRoot, "index.html");
      const indexData = yield* fileSystem
        .readFile(indexPath)
        .pipe(Effect.orElseSucceed(() => null));
      if (!indexData) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return HttpServerResponse.uint8Array(indexData, {
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: { "Cache-Control": "no-store" },
      });
    }

    const contentType = Mime.getType(filePath) ?? "application/octet-stream";
    const data = yield* fileSystem.readFile(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType,
      ...(contentType === "text/html" ? { headers: { "Cache-Control": "no-store" } } : {}),
    });
  }),
);

/**
 * `/api/hermes/brain` — status, dry run, and the enable switch.
 *
 * The switch lives in `ServerSettings.boardSettings`. Nothing ticks, calls a
 * backend or writes to the board until it is on; the dry run is the one
 * exception and it runs record-only.
 */
const withBrainDeps = <A>(use: (deps: HermesBrainDeps) => Promise<A>) =>
  Effect.gen(function* () {
    const deps = getHermesBrainDeps();
    if (!deps) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Hermes brain is not wired up on this server." },
        { status: 503 },
      );
    }
    const value = yield* Effect.promise(() => use(deps));
    return HttpServerResponse.jsonUnsafe(value, { headers: { "Cache-Control": "no-store" } });
  });

export const hermesBrainStatusRouteLayer = HttpRouter.add(
  "GET",
  "/api/hermes/brain",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    return yield* withBrainDeps(hermesBrainStatus);
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/**
 * The Hermes chat: every turn the loop sent and every answer it acted on.
 *
 * Read straight off the durable feed rather than through the brain deps — a
 * board whose brain failed to wire up is exactly when you want to scroll back.
 */
export const hermesChatRouteLayer = HttpRouter.add(
  "GET",
  "/api/hermes/chat",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const raw = Option.isSome(url) ? Number(url.value.searchParams.get("limit")) : Number.NaN;
    const limit = Number.isFinite(raw) ? Math.min(200, Math.max(1, Math.trunc(raw))) : 80;
    return HttpServerResponse.jsonUnsafe(
      { entries: hermesChatEntries(limit) },
      { headers: { "Cache-Control": "no-store" } },
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/** The friction log: what has been biting agents, deduped and counted. */
/** Rolling incident log (degradations + failed health checks), newest first. */
export const healthIncidentsRouteLayer = HttpRouter.add(
  "GET",
  "/api/health/incidents",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    return HttpServerResponse.jsonUnsafe(
      { incidents: [...readHealthIncidents(200)].reverse() },
      { headers: { "Cache-Control": "no-store" } },
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

function clampClientErrorField(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}

/**
 * Body: { message, details?, href? } — a web client crash report. The crash
 * screen posts here so a crashed browser leaves a trail on the box: the full
 * report in the server log, a summary line in the health incident log.
 */
export const clientErrorsRouteLayer = HttpRouter.add(
  "POST",
  "/api/client-errors",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rawBody = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const body = asJsonObject(rawBody);
    const message = clampClientErrorField(body.message, 500);
    if (message === null) {
      return HttpServerResponse.jsonUnsafe({ error: "message is required" }, { status: 400 });
    }
    const details = clampClientErrorField(body.details, 8_000) ?? "";
    const href = clampClientErrorField(body.href, 500) ?? "";

    yield* Effect.logError("Web client crashed", { message, href, details });
    recordHealthReport({
      at: DateTime.formatIso(yield* DateTime.now),
      ok: false,
      checks: [
        {
          id: "web.crash",
          title: "Web app crashed",
          severity: "critical",
          status: "fail",
          detail: href.length === 0 ? message : `${message} (${href})`,
        },
      ],
    });
    return HttpServerResponse.empty({ status: 204 });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const frictionListRouteLayer = HttpRouter.add(
  "GET",
  "/api/friction",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    return HttpServerResponse.jsonUnsafe(
      { entries: listFriction() },
      { headers: { "Cache-Control": "no-store" } },
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/** What the box has learned, newest first — candidates and retired ones included. */
export const knowledgeListRouteLayer = HttpRouter.add(
  "GET",
  "/api/hermes/knowledge",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    return HttpServerResponse.jsonUnsafe(
      { lessons: listLessons() },
      { headers: { "Cache-Control": "no-store" } },
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/**
 * Body: { lesson, projectId?, topic? } to teach one, or { id, reason } to
 * retire one. Teaching by hand is how the owner states a fact once instead of
 * repeating it into every thread.
 */
export const knowledgeWriteRouteLayer = HttpRouter.add(
  "POST",
  "/api/hermes/knowledge",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rawBody = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const body = asJsonObject(rawBody);
    const id = typeof body.id === "string" ? body.id : null;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (id !== null) {
      if (reason.length === 0) {
        return HttpServerResponse.jsonUnsafe({ error: "reason is required" }, { status: 400 });
      }
      const retired = retireLesson(id, reason);
      return retired === null
        ? HttpServerResponse.jsonUnsafe({ error: "unknown lesson" }, { status: 404 })
        : HttpServerResponse.jsonUnsafe(
            { lesson: retired },
            { headers: { "Cache-Control": "no-store" } },
          );
    }
    const lesson = typeof body.lesson === "string" ? body.lesson : "";
    const stored = recordLesson({
      lesson,
      source: "user",
      projectId: typeof body.projectId === "string" ? body.projectId : null,
      ...(typeof body.topic === "string" ? { topic: body.topic } : {}),
    });
    return stored === null
      ? HttpServerResponse.jsonUnsafe(
          { error: "a lesson is one usable sentence, not a phrase" },
          { status: 400 },
        )
      : HttpServerResponse.jsonUnsafe(
          { lesson: stored },
          { headers: { "Cache-Control": "no-store" } },
        );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/** Body: { fingerprint, status: open | carded | fixed | wontfix } */
export const frictionStatusRouteLayer = HttpRouter.add(
  "POST",
  "/api/friction/status",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rawBody = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const body = asJsonObject(rawBody);
    const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint : null;
    const status = body.status;
    const known =
      status === "open" || status === "carded" || status === "fixed" || status === "wontfix";
    if (fingerprint === null || !known) {
      return HttpServerResponse.jsonUnsafe(
        { error: "fingerprint and a status of open | carded | fixed | wontfix are required" },
        { status: 400 },
      );
    }
    const entry = setFrictionStatus(fingerprint, status);
    return entry === null
      ? HttpServerResponse.jsonUnsafe({ error: "unknown fingerprint" }, { status: 404 })
      : HttpServerResponse.jsonUnsafe({ entry }, { headers: { "Cache-Control": "no-store" } });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/**
 * `/api/maintenance` — what history has piled up, and the only way to delete it.
 *
 * Read is a survey: counts and bytes per target, so a confirmation can name the
 * exact thing. Nothing on this server calls the purge on its own — no sweep, no
 * startup hook, no Hermes tool. A human pressing a button in Settings is it.
 */
export const maintenanceSurveyRouteLayer = HttpRouter.add(
  "GET",
  "/api/maintenance",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const surveys = yield* surveyMaintenance;
    return HttpServerResponse.jsonUnsafe({ surveys }, { headers: { "Cache-Control": "no-store" } });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/** Body: `{ target, confirmItems, confirmPhrase? }`. Irreversible, one target. */
export const maintenancePurgeRouteLayer = HttpRouter.add(
  "POST",
  "/api/maintenance/purge",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rawBody = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const body = asJsonObject(rawBody);
    if (!isMaintenanceTargetId(body.target)) {
      return HttpServerResponse.jsonUnsafe(
        { error: `target must be one of ${MAINTENANCE_TARGET_IDS.join(", ")}` },
        { status: 400 },
      );
    }
    const target = body.target;
    const survey = yield* surveyMaintenanceTarget(target);
    const gate = checkPurgeConfirmation({
      target,
      confirmItems: body.confirmItems,
      confirmPhrase: body.confirmPhrase,
      survey,
    });
    if (!gate.ok) {
      return HttpServerResponse.jsonUnsafe(
        { error: gate.error, survey },
        { status: gate.status, headers: { "Cache-Control": "no-store" } },
      );
    }
    const result = yield* purgeMaintenanceTarget(target);
    console.log(JSON.stringify({ evt: "maintenance.purge", target, items: result.items }));
    return HttpServerResponse.jsonUnsafe({ result }, { headers: { "Cache-Control": "no-store" } });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/** One tick in record-only mode. Reads the real board; writes nothing. */
export const hermesBrainDryRunRouteLayer = HttpRouter.add(
  "POST",
  "/api/hermes/brain/dry-run",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    if (hermesBoardStatus().busy) {
      return HttpServerResponse.jsonUnsafe(
        { error: "A Hermes heartbeat or semantic tick is already running." },
        { status: 409 },
      );
    }
    return yield* withBrainDeps((deps) => runOneTick(deps, { recordOnly: true }));
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/** Full transcript for one logged tick: `?id=tick-12`. */
export const hermesBrainTickLogRouteLayer = HttpRouter.add(
  "GET",
  "/api/hermes/brain/log",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const id = Option.isSome(url) ? (url.value.searchParams.get("id") ?? "").trim() : "";
    const tick = id ? hermesTickById(id) : null;
    if (!tick) return HttpServerResponse.jsonUnsafe({ error: "No such tick." }, { status: 404 });
    return HttpServerResponse.jsonUnsafe(tick, { headers: { "Cache-Control": "no-store" } });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/** One real tick on demand. Writes to the board, so it needs the switch on. */
export const hermesBrainRunTickRouteLayer = HttpRouter.add(
  "POST",
  "/api/hermes/brain/tick",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const serverSettings = yield* ServerSettingsService;
    const current = yield* serverSettings.getSettings;
    if (!current.boardSettings.hermesBrainEnabled) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Turn Hermes on before running a real tick. Dry run works while it is off." },
        { status: 409 },
      );
    }
    if (hermesBoardStatus().busy) {
      return HttpServerResponse.jsonUnsafe(
        { error: "A Hermes heartbeat or semantic tick is already running." },
        { status: 409 },
      );
    }
    return yield* withBrainDeps((deps) => runOneTick(deps));
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/** Wipe the persisted conversation; the next tick starts from a full snapshot. */
export const hermesBrainConversationResetRouteLayer = HttpRouter.add(
  "POST",
  "/api/hermes/brain/conversation/reset",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    if (hermesBoardStatus().busy) {
      return HttpServerResponse.jsonUnsafe(
        { error: "A Hermes heartbeat or semantic tick is already running." },
        { status: 409 },
      );
    }
    yield* Effect.promise(() => resetHermesConversation(getHermesBrainDeps()?.backends ?? []));
    return HttpServerResponse.jsonUnsafe(hermesConversationStatus(), {
      headers: { "Cache-Control": "no-store" },
    });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/**
 * `/api/hermes/budget` — the measured table, the slider, and the dry-run plan.
 *
 * Every route here is read-only against the board. The plan route never writes;
 * it exists so a slider can show its own consequence before anything is spent.
 */
const withBudgetDeps = <A>(use: (deps: BudgetDeps) => Promise<A>) =>
  Effect.gen(function* () {
    const deps = getHermesBudgetDeps();
    if (!deps) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Hermes budget routing is not wired up on this server." },
        { status: 503 },
      );
    }
    const value = yield* Effect.promise(() => use(deps));
    return HttpServerResponse.jsonUnsafe(value, { headers: { "Cache-Control": "no-store" } });
  });

export const hermesBudgetStatusRouteLayer = HttpRouter.add(
  "GET",
  "/api/hermes/budget",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    return yield* withBudgetDeps(getBudgetStatus);
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/** Body: { enabled?, position? } */
export const hermesBudgetConfigureRouteLayer = HttpRouter.add(
  "POST",
  "/api/hermes/budget",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rawBody = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const body = asJsonObject(rawBody);
    const serverSettings = yield* ServerSettingsService;
    const current = yield* serverSettings.getSettings;
    yield* serverSettings.updateSettings({
      boardSettings: {
        ...current.boardSettings,
        ...(typeof body.enabled === "boolean" ? { hermesBudgetRoutingEnabled: body.enabled } : {}),
        ...(typeof body.position === "number"
          ? { hermesBudgetPosition: clampBudgetPosition(body.position) }
          : {}),
      },
    });
    return yield* withBudgetDeps(getBudgetStatus);
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/** Re-read every live thread's token snapshots into the measured table. */
export const hermesBudgetMeasureRouteLayer = HttpRouter.add(
  "POST",
  "/api/hermes/budget/measure",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    return yield* withBudgetDeps(async (deps) => {
      const measured = await refreshBudgetMeasurements(deps);
      return { ...measured, status: await getBudgetStatus(deps) };
    });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/** Dry run: body `{ text }` → the plan. Prints it to the journal, writes nothing. */
export const hermesBudgetPlanRouteLayer = HttpRouter.add(
  "POST",
  "/api/hermes/budget/plan",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rawBody = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const body = asJsonObject(rawBody);
    const text = typeof body.text === "string" ? body.text : "";
    if (text.trim().length === 0) {
      return HttpServerResponse.jsonUnsafe({ error: "text required" }, { status: 400 });
    }
    return yield* withBudgetDeps(async (deps) => {
      const plan = await buildPlanForText(deps, text);
      console.log(JSON.stringify({ evt: "hermes.plan", plan: formatBudgetPlan(plan) }));
      return plan;
    });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/** Body: { enabled?, instanceId?, model?, intervalMs?, maxNudges? } */
export const hermesBrainConfigureRouteLayer = HttpRouter.add(
  "POST",
  "/api/hermes/brain",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rawBody = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const body = asJsonObject(rawBody);
    const serverSettings = yield* ServerSettingsService;
    const current = yield* serverSettings.getSettings;
    const instanceId =
      typeof body.instanceId === "string" && body.instanceId.trim().length > 0
        ? body.instanceId.trim()
        : undefined;
    const board = current.boardSettings;
    // Switching the brain on while every pipeline gate is off buys a loop that
    // ticks and moves nothing — the state that reads as "Hermes ignored my
    // prompt". Enabling it hands the brain the pipeline; the three rows in
    // Settings → Board still turn any of it back off.
    const pipeline = boardRulePolicy(board);
    const openThePipeline =
      body.enabled === true &&
      !board.hermesBrainEnabled &&
      !pipeline.structureDrafts &&
      !pipeline.launchPrompts;
    const opened = openThePipeline
      ? {
          hermesAutoMoveDraftsToPrompts: true,
          ...hermesPipelinePatch(
            { ...board, ...hermesPipelinePatch(board, "structureDrafts", true) },
            "launchPrompts",
            true,
          ),
        }
      : {};
    const saved = yield* serverSettings.updateSettings({
      boardSettings: {
        ...board,
        ...opened,
        ...(typeof body.enabled === "boolean" ? { hermesBrainEnabled: body.enabled } : {}),
        ...(instanceId ? { hermesBrainInstanceId: instanceId } : {}),
        ...(typeof body.model === "string" ? { hermesBrainModel: body.model.trim() } : {}),
        ...(typeof body.intervalMs === "number" ? { hermesBrainIntervalMs: body.intervalMs } : {}),
        ...(typeof body.maxNudges === "number" ? { hermesBrainMaxNudges: body.maxNudges } : {}),
      },
    });
    // Before answering, not after: the change stream also applies this, but on
    // another fiber, so the response would otherwise report a loop that has not
    // started yet as idle and the panel would show "no ticks scheduled".
    applyHermesBrainSwitch(saved.boardSettings);
    return yield* withBrainDeps(hermesBrainStatus);
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);
