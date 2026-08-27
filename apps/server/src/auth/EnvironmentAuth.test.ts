import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthAdministrativeScopes } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";

import * as ServerSecretStore from "./ServerSecretStore.ts";

const makeServerConfigLayer = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        ...overrides,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-server-test-" })));

const makeEnvironmentAuthLayer = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  EnvironmentAuth.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(makeServerConfigLayer(overrides)),
  );

const makeCookieRequest = (
  sessionToken: string,
): Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]>[0] =>
  ({
    cookies: {
      t3_session: sessionToken,
    },
    headers: {},
  }) as unknown as Parameters<
    EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
  >[0];

const requestMetadata = {
  deviceType: "desktop" as const,
  os: "macOS",
  browser: "Chrome",
  ipAddress: "192.168.1.23",
};

const makeCloudflareAssertion = (options?: { readonly serviceTokenId: string }) => {
  // Distinct issuer + kid per fixture: verifyCloudflareAssertion caches JWKS by
  // issuer for an hour, so sharing them across tests reuses the wrong key.
  const issuer = options
    ? "https://service-token.cloudflareaccess.com"
    : "https://test.cloudflareaccess.com";
  const kid = options ? "service-token-key" : "test-key";
  const audience = "test-audience";
  const email = "user@example.com";
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify(
      options
        ? {
            iss: issuer,
            aud: audience,
            common_name: options.serviceTokenId.toUpperCase(),
            sub: "",
            type: "app",
            exp: 4_102_444_800,
          }
        : {
            iss: issuer,
            aud: audience,
            email: email.toUpperCase(),
            sub: "test-user",
            exp: 4_102_444_800,
          },
    ),
  ).toString("base64url");
  const signature = NodeCrypto.sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    privateKey,
  ).toString("base64url");
  return {
    audience,
    email,
    issuer,
    jwk: { ...publicKey.export({ format: "jwk" }), kid },
    token: `${header}.${payload}.${signature}`,
  };
};

it.layer(NodeServices.layer)("EnvironmentAuth.layer", (it) => {
  it.effect("classifies invalid bootstrap credential failures for the HTTP boundary", () =>
    Effect.sync(() => {
      const error = EnvironmentAuth.toBootstrapExchangeError(
        new PairingGrantStore.UnknownBootstrapCredentialError({}),
      );

      expect(error._tag).toBe("ServerAuthInvalidCredentialError");
    }),
  );

  it.effect("maps unexpected bootstrap failures to 500", () =>
    Effect.sync(() => {
      const cause = new PairingGrantStore.BootstrapCredentialConsumeError({
        cause: new Error("sqlite is unavailable"),
      });
      const error = EnvironmentAuth.toBootstrapExchangeError(cause);

      expect(error._tag).toBe("ServerAuthBootstrapCredentialValidationError");
      expect(error.message).toBe("Failed to validate bootstrap credential.");
      if (error._tag === "ServerAuthBootstrapCredentialValidationError") {
        expect(error.cause).toBe(cause);
      }
    }),
  );

  it.effect("issues standard pairing credentials by default", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;

      const pairingCredential = yield* serverAuth.issuePairingCredential();
      const exchanged = yield* serverAuth.createBrowserSession(
        pairingCredential.credential,
        requestMetadata,
      );
      const verified = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(exchanged.sessionToken),
      );

      expect(verified.sessionId.length).toBeGreaterThan(0);
      expect(verified.scopes).toEqual([
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
      ]);
      expect(verified.subject).toBe("one-time-token");
    }).pipe(Effect.provide(makeEnvironmentAuthLayer())),
  );

  it.effect("authenticates Cloudflare Access without creating durable T3 sessions", () => {
    const assertion = makeCloudflareAssertion();
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const originalFetch = globalThis.fetch;
        const originalEnv = {
          teamDomain: process.env.T3CODE_CLOUDFLARE_ACCESS_TEAM_DOMAIN,
          audience: process.env.T3CODE_CLOUDFLARE_ACCESS_AUDIENCE,
          email: process.env.T3CODE_CLOUDFLARE_ACCESS_EMAIL,
          origin: process.env.T3CODE_CLOUDFLARE_ACCESS_ORIGIN,
        };
        process.env.T3CODE_CLOUDFLARE_ACCESS_TEAM_DOMAIN = new URL(assertion.issuer).host;
        process.env.T3CODE_CLOUDFLARE_ACCESS_AUDIENCE = assertion.audience;
        process.env.T3CODE_CLOUDFLARE_ACCESS_EMAIL = assertion.email;
        process.env.T3CODE_CLOUDFLARE_ACCESS_ORIGIN = "https://code.example.com";
        globalThis.fetch = (() =>
          Promise.resolve(
            new Response(JSON.stringify({ keys: [assertion.jwk] })),
          )) as unknown as typeof fetch;
        return { originalEnv, originalFetch };
      }),
      () =>
        Effect.gen(function* () {
          const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
          const request = {
            cookies: {},
            headers: { "cf-access-jwt-assertion": assertion.token },
          } as unknown as Parameters<
            EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
          >[0];

          const first = yield* serverAuth.authenticateHttpRequest(request);
          const second = yield* serverAuth.authenticateHttpRequest(request);
          const sessions = yield* serverAuth.listClientSessions(first.sessionId);

          expect(first.sessionId).toBe("cloudflare:test-user");
          expect(second.sessionId).toBe(first.sessionId);
          expect(first.subject).toBe(assertion.email);
          expect(first.scopes).toEqual([
            "orchestration:read",
            "orchestration:operate",
            "terminal:operate",
            "review:write",
            "relay:read",
          ]);
          expect(sessions).toHaveLength(0);

          const websocketError = yield* serverAuth
            .authenticateWebSocketUpgrade({
              ...request,
              headers: {
                ...request.headers,
                origin: "https://attacker.example.com",
              },
            })
            .pipe(Effect.flip);
          expect(websocketError._tag).toBe("ServerAuthInvalidCredentialError");
        }).pipe(Effect.provide(makeEnvironmentAuthLayer())),
      ({ originalEnv, originalFetch }) =>
        Effect.sync(() => {
          globalThis.fetch = originalFetch;
          const restore = (name: string, value: string | undefined) => {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
          };
          restore("T3CODE_CLOUDFLARE_ACCESS_TEAM_DOMAIN", originalEnv.teamDomain);
          restore("T3CODE_CLOUDFLARE_ACCESS_AUDIENCE", originalEnv.audience);
          restore("T3CODE_CLOUDFLARE_ACCESS_EMAIL", originalEnv.email);
          restore("T3CODE_CLOUDFLARE_ACCESS_ORIGIN", originalEnv.origin);
        }),
    );
  });

  it.effect("authenticates Cloudflare Access service tokens without an email claim", () => {
    const serviceTokenId = "59bb40db2d204e1c439cc2e8fa96c806.access";
    const assertion = makeCloudflareAssertion({ serviceTokenId });
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const originalFetch = globalThis.fetch;
        const originalEnv = {
          teamDomain: process.env.T3CODE_CLOUDFLARE_ACCESS_TEAM_DOMAIN,
          audience: process.env.T3CODE_CLOUDFLARE_ACCESS_AUDIENCE,
          email: process.env.T3CODE_CLOUDFLARE_ACCESS_EMAIL,
          serviceTokenId: process.env.T3CODE_CLOUDFLARE_ACCESS_SERVICE_TOKEN_ID,
        };
        process.env.T3CODE_CLOUDFLARE_ACCESS_TEAM_DOMAIN = new URL(assertion.issuer).host;
        process.env.T3CODE_CLOUDFLARE_ACCESS_AUDIENCE = assertion.audience;
        process.env.T3CODE_CLOUDFLARE_ACCESS_EMAIL = "someone-else@example.com";
        process.env.T3CODE_CLOUDFLARE_ACCESS_SERVICE_TOKEN_ID = serviceTokenId;
        globalThis.fetch = (() =>
          Promise.resolve(
            new Response(JSON.stringify({ keys: [assertion.jwk] })),
          )) as unknown as typeof fetch;
        return { originalEnv, originalFetch };
      }),
      () =>
        Effect.gen(function* () {
          const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
          const request = {
            cookies: {},
            headers: { "cf-access-jwt-assertion": assertion.token },
          } as unknown as Parameters<
            EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
          >[0];

          const verified = yield* serverAuth.authenticateHttpRequest(request);

          expect(verified.sessionId).toBe(`cloudflare-service-token:${serviceTokenId}`);
          expect(verified.subject).toBe(`service-token:${serviceTokenId}`);
          expect(verified.scopes).toEqual([
            "orchestration:read",
            "orchestration:operate",
            "terminal:operate",
            "review:write",
            "relay:read",
          ]);
          expect(yield* serverAuth.listClientSessions(verified.sessionId)).toHaveLength(0);

          process.env.T3CODE_CLOUDFLARE_ACCESS_SERVICE_TOKEN_ID = "other-token.access";
          const rejected = yield* serverAuth.authenticateHttpRequest(request).pipe(Effect.flip);
          expect(rejected._tag).toBe("ServerAuthInvalidCredentialError");
        }).pipe(Effect.provide(makeEnvironmentAuthLayer())),
      ({ originalEnv, originalFetch }) =>
        Effect.sync(() => {
          globalThis.fetch = originalFetch;
          const restore = (name: string, value: string | undefined) => {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
          };
          restore("T3CODE_CLOUDFLARE_ACCESS_TEAM_DOMAIN", originalEnv.teamDomain);
          restore("T3CODE_CLOUDFLARE_ACCESS_AUDIENCE", originalEnv.audience);
          restore("T3CODE_CLOUDFLARE_ACCESS_EMAIL", originalEnv.email);
          restore("T3CODE_CLOUDFLARE_ACCESS_SERVICE_TOKEN_ID", originalEnv.serviceTokenId);
        }),
    );
  });

  it.effect("does not exchange ordinary pairing grants for administrative access tokens", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const pairingCredential = yield* serverAuth.issuePairingCredential();

      const error = yield* serverAuth
        .exchangeBootstrapCredentialForAccessToken(
          pairingCredential.credential,
          ["orchestration:read", "access:write"],
          requestMetadata,
        )
        .pipe(Effect.flip);

      expect(error._tag).toBe("ServerAuthScopeNotGrantedError");
    }).pipe(Effect.provide(makeEnvironmentAuthLayer())),
  );

  it.effect("inherits a constrained pairing grant when token exchange omits scope", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const pairingCredential = yield* serverAuth.issuePairingCredential({
        scopes: ["orchestration:read"],
      });

      const token = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        pairingCredential.credential,
        undefined,
        requestMetadata,
      );

      expect(token.scope).toBe("orchestration:read");
    }).pipe(Effect.provide(makeEnvironmentAuthLayer())),
  );

  it.effect("keeps user-issued administrative pairing links manageable", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const pairingCredential = yield* serverAuth.issuePairingCredential({
        scopes: AuthAdministrativeScopes,
      });
      const listedPairingLinks = yield* serverAuth.listPairingLinks();

      expect(
        listedPairingLinks.find((pairingLink) => pairingLink.id === pairingCredential.id)?.subject,
      ).toBe("one-time-token");
    }).pipe(Effect.provide(makeEnvironmentAuthLayer())),
  );

  it.effect("issues startup pairing URLs that bootstrap administrative sessions", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;

      const pairingUrl = yield* serverAuth.issueStartupPairingUrl("http://127.0.0.1:3773");
      const token = new URLSearchParams(new URL(pairingUrl).hash.slice(1)).get("token");
      const listedPairingLinks = yield* serverAuth.listPairingLinks();
      expect(token).toBeTruthy();
      expect(
        listedPairingLinks.some(
          (pairingLink) => pairingLink.subject === "administrative-bootstrap",
        ),
      ).toBe(false);

      const exchanged = yield* serverAuth.createBrowserSession(token ?? "", requestMetadata);
      const verified = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(exchanged.sessionToken),
      );

      expect(verified.scopes).toEqual([
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
        "access:read",
        "access:write",
        "relay:write",
      ]);
      expect(verified.subject).toBe("administrative-bootstrap");
    }).pipe(Effect.provide(makeEnvironmentAuthLayer())),
  );

  it.effect(
    "lists pairing links and revokes other sessions while keeping the administrative session",
    () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;

        const administrativeExchange = yield* serverAuth.createBrowserSession(
          "desktop-bootstrap-token",
          requestMetadata,
        );
        const administrativeSession = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(administrativeExchange.sessionToken),
        );
        const pairingCredential = yield* serverAuth.issuePairingCredential({
          label: "Julius iPhone",
        });
        const listedPairingLinks = yield* serverAuth.listPairingLinks();
        const clientExchange = yield* serverAuth.createBrowserSession(
          pairingCredential.credential,
          {
            ...requestMetadata,
            deviceType: "mobile",
            os: "iOS",
            browser: "Safari",
            ipAddress: "192.168.1.88",
          },
        );
        const clientSession = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(clientExchange.sessionToken),
        );
        const clientsBeforeRevoke = yield* serverAuth.listClientSessions(
          administrativeSession.sessionId,
        );
        const revokedCount = yield* serverAuth.revokeOtherClientSessions(
          administrativeSession.sessionId,
        );
        const clientsAfterRevoke = yield* serverAuth.listClientSessions(
          administrativeSession.sessionId,
        );

        expect(listedPairingLinks.map((entry) => entry.id)).toContain(pairingCredential.id);
        expect(listedPairingLinks.find((entry) => entry.id === pairingCredential.id)?.label).toBe(
          "Julius iPhone",
        );
        expect(clientsBeforeRevoke).toHaveLength(2);
        expect(
          clientsBeforeRevoke.find((entry) => entry.sessionId === administrativeSession.sessionId)
            ?.current,
        ).toBe(true);
        expect(
          clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.current,
        ).toBe(false);
        expect(
          clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.client
            .label,
        ).toBe("Julius iPhone");
        expect(
          clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.client
            .deviceType,
        ).toBe("mobile");
        expect(revokedCount).toBe(1);
        expect(clientsAfterRevoke).toHaveLength(1);
        expect(clientsAfterRevoke[0]?.sessionId).toBe(administrativeSession.sessionId);
      }).pipe(
        Effect.provide(
          makeEnvironmentAuthLayer({
            desktopBootstrapToken: "desktop-bootstrap-token",
          }),
        ),
      ),
  );
});
