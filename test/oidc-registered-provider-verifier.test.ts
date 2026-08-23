import { createPrivateKey } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { type OidcIdTokenAuthenticationEvent } from "@github-app-token-broker/oidc/id-token-authenticator";
import {
  createOidcProviderRegistration,
  type OidcProviderRegistration,
} from "@github-app-token-broker/oidc/provider-registration";

import {
  createRegisteredOidcProviderVerifier,
  type RegisteredOidcProviderVerifier,
} from "../packages/oidc/src/registered-provider-verifier.ts";
import {
  authenticationTestNow,
  expectedFailure,
  issuer,
  jwksUri,
  providerFetch,
  registration,
  signedIdToken,
  subjectTokenAudience,
  successfulProviderFetch,
} from "./support/oidc-id-token-authenticator-fixture.ts";
import { testPrivateKeyPem, testPublicJwk } from "./support/rsa-test-key-pair.ts";

describe("Registered OIDC Provider Verifier", () => {
  it("caches validated Provider Configuration and JWK Set documents", async () => {
    const fetchOidcRemoteDocumentResponse = vi.fn(successfulProviderFetch);
    const verifier = testVerifier(fetchOidcRemoteDocumentResponse);
    const subjectToken = await signedIdToken();

    expect((await verifier.verifyIdToken(subjectToken)).ok).toBe(true);
    expect((await verifier.verifyIdToken(subjectToken)).ok).toBe(true);
    expect(
      fetchOidcRemoteDocumentResponse.mock.calls.map(([input]) => new Request(input).url),
    ).toEqual([`${issuer}/.well-known/openid-configuration`, jwksUri]);
    expect(fetchOidcRemoteDocumentResponse.mock.calls.map(([, init]) => init?.redirect)).toEqual([
      "manual",
      "manual",
    ]);
  });

  it("verifies a token without a key ID against a singleton JWK Set", async () => {
    await expect(
      testVerifier(successfulProviderFetch).verifyIdToken(await signedIdToken({ kid: null })),
    ).resolves.toMatchObject({
      ok: true,
      verificationEvidence: { resolvedKeyId: null },
    });
  });

  it("rejects a Provider Configuration redirect without using or caching its document", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    let configurationIsDirect = false;
    const events: OidcIdTokenAuthenticationEvent[] = [];
    const fetchOidcRemoteDocumentResponse = vi.fn<typeof fetch>(async (input, init) => {
      const url = new Request(input).url;

      if (url === `${issuer}/.well-known/openid-configuration`) {
        if (!configurationIsDirect) {
          return oidcRedirectResponse();
        }

        return successfulProviderFetch(input, init);
      }

      return successfulProviderFetch(input, init);
    });
    const observe = (event: OidcIdTokenAuthenticationEvent) => events.push(event);
    const verifier = testVerifier(fetchOidcRemoteDocumentResponse, () => now);
    const subjectToken = await signedIdToken();

    await expect(verifier.verifyIdToken(subjectToken, observe)).resolves.toEqual(
      expectedFailure("provider_unavailable", "ERR_OIDC_PROVIDER_CONFIGURATION_HTTP_STATUS", 302),
    );
    await expect(verifier.verifyIdToken(subjectToken, observe)).resolves.toEqual(
      expectedFailure("provider_unavailable", "ERR_OIDC_PROVIDER_CONFIGURATION_HTTP_STATUS", 302),
    );
    expect(fetchOidcRemoteDocumentResponse).toHaveBeenCalledOnce();
    expect(events).not.toContainEqual(
      expect.objectContaining({ event: "oidc_provider_configuration_refreshed" }),
    );

    configurationIsDirect = true;
    now = new Date(now.getTime() + 10_001);
    await expect(verifier.verifyIdToken(subjectToken, observe)).resolves.toMatchObject({
      ok: true,
    });
    expect(
      fetchOidcRemoteDocumentResponse.mock.calls.map(([input]) => new Request(input).url),
    ).toEqual([
      `${issuer}/.well-known/openid-configuration`,
      `${issuer}/.well-known/openid-configuration`,
      jwksUri,
    ]);
  });

  it("rejects an initial JWK Set redirect without using or caching its document", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    let jwksIsDirect = false;
    const fetchOidcRemoteDocumentResponse = vi.fn<typeof fetch>(async (input, init) => {
      const url = new Request(input).url;

      if (url === jwksUri && !jwksIsDirect) {
        return oidcRedirectResponse();
      }

      return successfulProviderFetch(input, init);
    });
    const verifier = testVerifier(fetchOidcRemoteDocumentResponse, () => now);
    const subjectToken = await signedIdToken();

    await expect(verifier.verifyIdToken(subjectToken)).resolves.toEqual(
      expectedFailure("provider_unavailable", "ERR_OIDC_JWKS_HTTP_STATUS", 302),
    );
    await expect(verifier.verifyIdToken(subjectToken)).resolves.toEqual(
      expectedFailure("provider_unavailable", "ERR_OIDC_JWKS_HTTP_STATUS", 302),
    );
    expect(
      fetchOidcRemoteDocumentResponse.mock.calls.filter(
        ([input]) => new Request(input).url === jwksUri,
      ),
    ).toHaveLength(1);

    jwksIsDirect = true;
    now = new Date(now.getTime() + 10_001);
    await expect(verifier.verifyIdToken(subjectToken)).resolves.toMatchObject({
      ok: true,
    });
    expect(
      fetchOidcRemoteDocumentResponse.mock.calls.filter(
        ([input]) => new Request(input).url === jwksUri,
      ),
    ).toHaveLength(2);
  });

  it("contains a Provider Configuration observer failure without recording provider backoff", async () => {
    const events: OidcIdTokenAuthenticationEvent[] = [];
    const fetchOidcRemoteDocumentResponse = vi.fn(providerFetch({ cacheControl: "no-store" }));
    const verifier = testVerifier(fetchOidcRemoteDocumentResponse);
    const observe = (event: OidcIdTokenAuthenticationEvent) => {
      events.push(event);

      if (event.event === "oidc_provider_configuration_refreshed") {
        throw new Error("Provider Configuration observer unavailable");
      }
    };
    const subjectToken = await signedIdToken();

    await expect(verifier.verifyIdToken(subjectToken, observe)).resolves.toMatchObject({
      ok: true,
    });
    expect(
      fetchOidcRemoteDocumentResponse.mock.calls.filter(
        ([input]) => new Request(input).url === `${issuer}/.well-known/openid-configuration`,
      ),
    ).toHaveLength(1);
    expect(
      fetchOidcRemoteDocumentResponse.mock.calls.filter(
        ([input]) => new Request(input).url === jwksUri,
      ),
    ).toHaveLength(1);
    expect(events.filter((event) => event.event === "oidc_remote_document_refresh_failed")).toEqual(
      [],
    );

    await expect(verifier.verifyIdToken(subjectToken, observe)).resolves.toMatchObject({
      ok: true,
    });
    expect(
      fetchOidcRemoteDocumentResponse.mock.calls.filter(
        ([input]) => new Request(input).url === `${issuer}/.well-known/openid-configuration`,
      ),
    ).toHaveLength(2);
    expect(
      fetchOidcRemoteDocumentResponse.mock.calls.filter(
        ([input]) => new Request(input).url === jwksUri,
      ),
    ).toHaveLength(2);
    expect(
      events.filter((event) => event.event === "oidc_provider_configuration_refreshed"),
    ).toHaveLength(2);
    expect(events.filter((event) => event.event === "oidc_remote_document_refresh_failed")).toEqual(
      [],
    );
  });

  it("enforces the subject-token audience as one exact scalar value", async () => {
    const verifier = testVerifier(successfulProviderFetch);

    await expect(
      verifier.verifyIdToken(
        await signedIdToken({ audience: ["github-app-token-broker", "other"] }),
      ),
    ).resolves.toEqual(
      expectedFailure("subject_token_rejected", "ERR_JWT_CLAIM_VALIDATION_FAILED"),
    );
  });

  it("retains arbitrary signed claims in the verified subject token", async () => {
    const verifier = testVerifier(successfulProviderFetch);

    await expect(
      verifier.verifyIdToken(
        await signedIdToken({
          claims: {
            event_name: "workflow_dispatch",
            ref: "refs/heads/main",
            ref_type: "branch",
            repository: "octo-org/example",
            workflow_ref: "octo-org/example/.github/workflows/deploy.yml@refs/heads/main",
          },
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      verifiedSubjectToken: {
        claims: {
          event_name: "workflow_dispatch",
          ref: "refs/heads/main",
          ref_type: "branch",
          repository: "octo-org/example",
          workflow_ref: "octo-org/example/.github/workflows/deploy.yml@refs/heads/main",
        },
      },
    });
  });

  it("passes retained signed custom claims to the OIDC ID Token Profile", async () => {
    const validate = vi.fn((claims) => claims["repository"] === "octo-org/example");
    const profileRegistration = createOidcProviderRegistration({
      acceptedIdTokenSigningAlgorithms: ["RS256"],
      idTokenProfile: { validate },
      issuer,
    });
    const verifier = testVerifier(successfulProviderFetch, undefined, profileRegistration);

    await expect(
      verifier.verifyIdToken(await signedIdToken({ claims: { repository: "octo-org/example" } })),
    ).resolves.toMatchObject({ ok: true });
    expect(validate).toHaveBeenCalledWith(
      expect.objectContaining({ repository: "octo-org/example" }),
    );
  });

  it("protects top-level and nested verified Claims from profile mutation", async () => {
    const profileRegistration = createOidcProviderRegistration({
      acceptedIdTokenSigningAlgorithms: ["RS256"],
      idTokenProfile: {
        validate: (claims) => {
          try {
            // @ts-expect-error Verified Claims are readonly at the profile boundary.
            claims.sub = "mutated-subject";
          } catch {}

          try {
            const context = claims["context"];

            if (typeof context === "object" && context !== null && !Array.isArray(context)) {
              // @ts-expect-error Nested verified Claim values are recursively readonly.
              context.branch = "refs/heads/mutated";
            }
          } catch {}

          try {
            const environments = claims["environments"];

            if (Array.isArray(environments)) {
              environments.push("production");
            }
          } catch {}

          return true;
        },
      },
      issuer,
    });
    const verifier = testVerifier(successfulProviderFetch, undefined, profileRegistration);

    await expect(
      verifier.verifyIdToken(
        await signedIdToken({
          claims: {
            context: { branch: "refs/heads/main" },
            environments: ["staging"],
          },
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      verifiedSubjectToken: {
        claims: {
          context: { branch: "refs/heads/main" },
          environments: ["staging"],
          sub: "subject",
        },
      },
    });
  });

  it("uses one injected operation time for caches and JWT expiry validation", async () => {
    const now = vi
      .fn<() => Date>()
      .mockReturnValueOnce(new Date("2031-01-01T00:00:00Z"))
      .mockReturnValue(new Date("2020-01-01T00:00:00Z"));
    const verifier = testVerifier(successfulProviderFetch, now);

    await expect(
      verifier.verifyIdToken(
        await signedIdToken({
          claims: {
            exp: Date.parse("2030-01-01T00:00:00Z") / 1000,
            iat: Date.parse("2020-01-01T00:00:00Z") / 1000,
          },
        }),
      ),
    ).resolves.toEqual(expectedFailure("subject_token_rejected", "ERR_JWT_EXPIRED"));
    expect(now).toHaveBeenCalledOnce();
  });

  it.each([
    ["an empty subject", { sub: "" }, "ERR_JWT_CLAIM_VALIDATION_FAILED"],
    ["a non-string subject", { sub: 1 }, "ERR_JWT_CLAIM_VALIDATION_FAILED"],
    ["a missing issued-at time", { iat: undefined }, "ERR_JWT_CLAIM_VALIDATION_FAILED"],
    ["a non-numeric expiration time", { exp: "not-a-number" }, "ERR_JWT_CLAIM_VALIDATION_FAILED"],
  ])(
    "preserves the rejection classification for %s",
    async (_description, claims, diagnosticCode) => {
      await expect(
        testVerifier(successfulProviderFetch).verifyIdToken(await signedIdToken({ claims })),
      ).resolves.toEqual(expectedFailure("subject_token_rejected", diagnosticCode));
    },
  );

  it("uses the injected clock when validating token expiry", async () => {
    const afterTokenExpiry = new Date(authenticationTestNow.getTime() + 301_000);

    await expect(
      testVerifier(successfulProviderFetch, () => afterTokenExpiry).verifyIdToken(
        await signedIdToken(),
      ),
    ).resolves.toEqual(expectedFailure("subject_token_rejected", "ERR_JWT_EXPIRED"));
  });

  it("rejects a subject token when provider metadata omits required RS256", async () => {
    const fetchOidcRemoteDocumentResponse = providerFetch({
      advertisedIdTokenSigningAlgorithms: ["ES256"],
    });

    await expect(
      testVerifier(fetchOidcRemoteDocumentResponse).verifyIdToken(await signedIdToken()),
    ).resolves.toEqual(expectedFailure("subject_token_rejected", "ERR_OIDC_METADATA_INVALID"));

    await expect(
      testVerifier(successfulProviderFetch).verifyIdToken(
        await signedIdToken({ algorithm: "RS512" }),
      ),
    ).resolves.toEqual(expectedFailure("subject_token_rejected", "ERR_JOSE_ALG_NOT_ALLOWED"));
  });

  it("rate-limits JWKS refreshes triggered by attacker-controlled unknown kids", async () => {
    let now = authenticationTestNow;
    const fetchOidcRemoteDocumentResponse = vi.fn(successfulProviderFetch);
    const verifier = testVerifier(fetchOidcRemoteDocumentResponse, () => now);
    const unknownKeyToken = await signedIdToken({ kid: "unknown-key" });

    await expect(verifier.verifyIdToken(unknownKeyToken)).resolves.toEqual(
      expectedFailure("subject_token_rejected", "ERR_JWKS_NO_MATCHING_KEY"),
    );
    expect(
      fetchOidcRemoteDocumentResponse.mock.calls.filter(
        ([input]) => new Request(input).url === jwksUri,
      ),
    ).toHaveLength(1);

    now = new Date(now.getTime() + 10_001);
    await verifier.verifyIdToken(unknownKeyToken);
    expect(
      fetchOidcRemoteDocumentResponse.mock.calls.filter(
        ([input]) => new Request(input).url === jwksUri,
      ),
    ).toHaveLength(2);
  });

  it("rejects a forced JWK Set refresh redirect without replacing cached keys", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    let jwksMode: "initial" | "redirect" | "rotated" = "initial";
    const fetchOidcRemoteDocumentResponse = vi.fn<typeof fetch>(async (input, init) => {
      const url = new Request(input).url;

      if (url !== jwksUri) {
        return successfulProviderFetch(input, init);
      }

      if (jwksMode === "redirect") {
        return oidcRedirectResponse();
      }

      return Response.json({
        keys: [jwksMode === "rotated" ? { ...testPublicJwk, kid: "unknown-key" } : testPublicJwk],
      });
    });
    const events: OidcIdTokenAuthenticationEvent[] = [];
    const observe = (event: OidcIdTokenAuthenticationEvent) => events.push(event);
    const verifier = testVerifier(fetchOidcRemoteDocumentResponse, () => now);

    await expect(verifier.verifyIdToken(await signedIdToken(), observe)).resolves.toMatchObject({
      ok: true,
    });

    jwksMode = "redirect";
    now = new Date(now.getTime() + 10_001);
    const rotatedSubjectToken = await signedIdToken({ kid: "unknown-key" });
    await expect(verifier.verifyIdToken(rotatedSubjectToken, observe)).resolves.toEqual(
      expectedFailure("subject_token_rejected", "ERR_JWKS_NO_MATCHING_KEY"),
    );
    await expect(verifier.verifyIdToken(rotatedSubjectToken, observe)).resolves.toEqual(
      expectedFailure("subject_token_rejected", "ERR_JWKS_NO_MATCHING_KEY"),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        diagnosticCode: "ERR_OIDC_JWKS_HTTP_STATUS",
        event: "oidc_remote_document_refresh_failed",
        providerHttpStatus: 302,
        remoteDocumentKind: "jwk_set",
      }),
    );
    await expect(verifier.verifyIdToken(await signedIdToken(), observe)).resolves.toMatchObject({
      ok: true,
    });
    expect(
      fetchOidcRemoteDocumentResponse.mock.calls.filter(
        ([input]) => new Request(input).url === jwksUri,
      ),
    ).toHaveLength(2);

    jwksMode = "rotated";
    now = new Date(now.getTime() + 10_001);
    await expect(verifier.verifyIdToken(rotatedSubjectToken, observe)).resolves.toMatchObject({
      ok: true,
    });
    expect(
      fetchOidcRemoteDocumentResponse.mock.calls.filter(
        ([input]) => new Request(input).url === jwksUri,
      ),
    ).toHaveLength(3);
  });

  it.each(["no-cache", "no-store"])(
    "does not reuse a %s JWK Set after an unknown kid when refresh fails",
    async (cacheControl) => {
      let jwksRequests = 0;
      const fetchOidcRemoteDocumentResponse = providerFetch({
        jwksResponse: () => {
          jwksRequests += 1;

          return jwksRequests === 1
            ? Response.json(
                { keys: [testPublicJwk] },
                { headers: { "cache-control": cacheControl } },
              )
            : oidcRedirectResponse();
        },
      });

      await expect(
        testVerifier(fetchOidcRemoteDocumentResponse).verifyIdToken(
          await signedIdToken({ kid: "unknown-key" }),
        ),
      ).resolves.toEqual(expectedFailure("provider_unavailable", "ERR_OIDC_JWKS_HTTP_STATUS", 302));
      expect(jwksRequests).toBe(2);
    },
  );

  it("publishes each coalesced Provider Configuration refresh once", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const replacementJwksUri = "https://keys.example/tenant/replacement-jwks";
    const providerConfigurationResponses = [
      Promise.withResolvers<Response>(),
      Promise.withResolvers<Response>(),
    ];
    let providerConfigurationRequests = 0;
    const events: OidcIdTokenAuthenticationEvent[] = [];
    const fetchOidcRemoteDocumentResponse = vi.fn<typeof fetch>((input, init) => {
      const url = new Request(input).url;

      if (url === `${issuer}/.well-known/openid-configuration`) {
        const response = providerConfigurationResponses[providerConfigurationRequests];
        providerConfigurationRequests += 1;

        return response?.promise ?? Promise.resolve(new Response(null, { status: 500 }));
      }

      if (url === replacementJwksUri) {
        return Promise.resolve(Response.json({ keys: [testPublicJwk] }));
      }

      return successfulProviderFetch(input, init);
    });
    const observe = (event: OidcIdTokenAuthenticationEvent) => events.push(event);
    const verifier = testVerifier(fetchOidcRemoteDocumentResponse, () => now);
    const subjectToken = await signedIdToken();

    const firstResults = Promise.all([
      verifier.verifyIdToken(subjectToken, observe),
      verifier.verifyIdToken(subjectToken, observe),
    ]);

    expect(providerConfigurationRequests).toBe(1);
    providerConfigurationResponses[0]?.resolve(providerConfigurationResponse("max-age=1"));
    expect((await firstResults).every((result) => result.ok)).toBe(true);
    expect(
      events.filter((event) => event.event === "oidc_provider_configuration_refreshed"),
    ).toEqual([
      {
        event: "oidc_provider_configuration_refreshed",
        freshUntil: expect.any(String),
        issuer: registration.issuer,
        jwkSetHost: "keys.example",
        metadataGeneration: 1,
        staleUntil: expect.any(String),
      },
    ]);

    now = new Date(now.getTime() + 1_001);
    const secondResults = Promise.all([
      verifier.verifyIdToken(subjectToken, observe),
      verifier.verifyIdToken(subjectToken, observe),
    ]);

    expect(providerConfigurationRequests).toBe(2);
    providerConfigurationResponses[1]?.resolve(
      providerConfigurationResponse("max-age=1", replacementJwksUri),
    );
    expect((await secondResults).every((result) => result.ok)).toBe(true);
    expect(
      events
        .filter((event) => event.event === "oidc_provider_configuration_refreshed")
        .map((event) => event.metadataGeneration),
    ).toEqual([1, 2]);
    expect(
      fetchOidcRemoteDocumentResponse.mock.calls.filter(([input]) =>
        [jwksUri, replacementJwksUri].includes(new Request(input).url),
      ),
    ).toHaveLength(2);
    expect(events.filter((event) => event.event === "oidc_provider_jwks_uri_changed")).toEqual([
      expect.objectContaining({
        jwkSetHost: "keys.example",
        metadataGeneration: 2,
        previousJwkSetHost: "keys.example",
      }),
    ]);
  });

  it("publishes a coalesced Provider Configuration refresh failure once", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const failedRefresh = Promise.withResolvers<Response>();
    let providerConfigurationRequests = 0;
    const events: OidcIdTokenAuthenticationEvent[] = [];
    const fetchOidcRemoteDocumentResponse = vi.fn<typeof fetch>((input, init) => {
      if (new Request(input).url === `${issuer}/.well-known/openid-configuration`) {
        providerConfigurationRequests += 1;

        return providerConfigurationRequests === 1
          ? Promise.resolve(providerConfigurationResponse("max-age=1"))
          : failedRefresh.promise;
      }

      return successfulProviderFetch(input, init);
    });
    const observe = (event: OidcIdTokenAuthenticationEvent) => events.push(event);
    const verifier = testVerifier(fetchOidcRemoteDocumentResponse, () => now);
    const subjectToken = await signedIdToken();

    await expect(verifier.verifyIdToken(subjectToken, observe)).resolves.toMatchObject({
      ok: true,
    });
    now = new Date(now.getTime() + 1_001);
    const results = Promise.all([
      verifier.verifyIdToken(subjectToken, observe),
      verifier.verifyIdToken(subjectToken, observe),
    ]);

    expect(providerConfigurationRequests).toBe(2);
    failedRefresh.resolve(new Response(null, { status: 503 }));
    expect((await results).every((result) => result.ok)).toBe(true);
    expect(
      events.filter(
        (event) =>
          event.event === "oidc_remote_document_refresh_failed" &&
          event.remoteDocumentKind === "provider_configuration",
      ),
    ).toEqual([
      expect.objectContaining({
        diagnosticCode: "ERR_OIDC_PROVIDER_CONFIGURATION_HTTP_STATUS",
        metadataGeneration: 1,
        providerHttpStatus: 503,
      }),
    ]);
    expect(
      events.filter(
        (event) =>
          event.event === "oidc_remote_document_stale_used" &&
          event.remoteDocumentKind === "provider_configuration",
      ),
    ).toHaveLength(2);

    await expect(verifier.verifyIdToken(subjectToken, observe)).resolves.toMatchObject({
      ok: true,
    });
    expect(providerConfigurationRequests).toBe(2);
    expect(
      events.filter(
        (event) =>
          event.event === "oidc_remote_document_refresh_failed" &&
          event.remoteDocumentKind === "provider_configuration",
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.event === "oidc_remote_document_stale_used" &&
          event.remoteDocumentKind === "provider_configuration",
      ),
    ).toHaveLength(3);
  });

  it("contains a coalesced JWK Set refresh-failure observer failure", async () => {
    const events: OidcIdTokenAuthenticationEvent[] = [];
    const scenario = await beginCoalescedJwksRefreshFailure((event) => {
      events.push(event);

      if (
        event.event === "oidc_remote_document_refresh_failed" &&
        event.remoteDocumentKind === "jwk_set"
      ) {
        throw new Error("JWK Set refresh-failure observer unavailable");
      }
    });

    expect(scenario.jwksRequests()).toBe(2);
    scenario.failedRefresh.resolve(new Response(null, { status: 503 }));
    expect((await scenario.results).every((result) => result.ok)).toBe(true);
    expect(
      events.filter(
        (event) =>
          event.event === "oidc_remote_document_refresh_failed" &&
          event.remoteDocumentKind === "jwk_set",
      ),
    ).toEqual([
      expect.objectContaining({
        diagnosticCode: "ERR_OIDC_JWKS_HTTP_STATUS",
        metadataGeneration: 1,
        providerHttpStatus: 503,
      }),
    ]);
    expect(
      events.filter(
        (event) =>
          event.event === "oidc_remote_document_stale_used" &&
          event.remoteDocumentKind === "jwk_set",
      ),
    ).toHaveLength(2);

    await expect(
      scenario.verifier.verifyIdToken(scenario.subjectToken, (event) => events.push(event)),
    ).resolves.toMatchObject({
      ok: true,
    });
    expect(scenario.jwksRequests()).toBe(2);
    expect(
      events.filter(
        (event) =>
          event.event === "oidc_remote_document_refresh_failed" &&
          event.remoteDocumentKind === "jwk_set",
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.event === "oidc_remote_document_stale_used" &&
          event.remoteDocumentKind === "jwk_set",
      ),
    ).toHaveLength(3);
  });

  it("does not reuse a cached JWK Set after metadata changes the accepted signing-algorithm intersection", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    let providerConfigurationRequests = 0;
    let jwksRequests = 0;
    const algorithmRegistration = createOidcProviderRegistration({
      acceptedIdTokenSigningAlgorithms: ["RS256", "RS512"],
      idTokenProfile: { validate: () => true },
      issuer,
    });
    const fetchOidcRemoteDocumentResponse = vi.fn<typeof fetch>(async (input) => {
      const url = new Request(input).url;

      if (url === `${issuer}/.well-known/openid-configuration`) {
        providerConfigurationRequests += 1;

        return Response.json(
          {
            id_token_signing_alg_values_supported: [
              ...(providerConfigurationRequests === 1 ? [] : ["RS512"]),
              "RS256",
            ],
            issuer,
            jwks_uri: jwksUri,
          },
          { headers: { "cache-control": "max-age=1" } },
        );
      }

      if (url === jwksUri) {
        jwksRequests += 1;

        return Response.json(
          {
            keys: [{ ...testPublicJwk, alg: jwksRequests === 1 ? "RS256" : "RS512" }],
          },
          { headers: { "cache-control": "max-age=300" } },
        );
      }

      return new Response(null, { status: 404 });
    });
    const verifier = testVerifier(
      fetchOidcRemoteDocumentResponse,
      () => now,
      algorithmRegistration,
    );

    expect((await verifier.verifyIdToken(await signedIdToken())).ok).toBe(true);
    now = new Date("2026-01-01T00:00:02Z");
    expect((await verifier.verifyIdToken(await signedIdToken({ algorithm: "RS512" }))).ok).toBe(
      true,
    );
    expect(jwksRequests).toBe(2);
  });

  it("does not reuse JWK Set failure backoff after the resolution identity changes", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    let providerConfigurationRequests = 0;
    let jwksRequests = 0;
    const algorithmRegistration = createOidcProviderRegistration({
      acceptedIdTokenSigningAlgorithms: ["RS256", "RS512"],
      idTokenProfile: { validate: () => true },
      issuer,
    });
    const fetchOidcRemoteDocumentResponse = vi.fn<typeof fetch>(async (input) => {
      const url = new Request(input).url;

      if (url === `${issuer}/.well-known/openid-configuration`) {
        providerConfigurationRequests += 1;

        return Response.json(
          {
            id_token_signing_alg_values_supported: [
              ...(providerConfigurationRequests === 1 ? [] : ["RS512"]),
              "RS256",
            ],
            issuer,
            jwks_uri: jwksUri,
          },
          { headers: { "cache-control": "max-age=1" } },
        );
      }

      if (url === jwksUri) {
        jwksRequests += 1;

        if (jwksRequests === 1) {
          return new Response(null, { status: 503 });
        }

        return Response.json(
          { keys: [{ ...testPublicJwk, alg: "RS512" }] },
          { headers: { "cache-control": "max-age=300" } },
        );
      }

      return new Response(null, { status: 404 });
    });
    const verifier = testVerifier(
      fetchOidcRemoteDocumentResponse,
      () => now,
      algorithmRegistration,
    );

    await expect(verifier.verifyIdToken(await signedIdToken())).resolves.toEqual(
      expectedFailure("provider_unavailable", "ERR_OIDC_JWKS_HTTP_STATUS", 503),
    );
    now = new Date("2026-01-01T00:00:02Z");
    expect((await verifier.verifyIdToken(await signedIdToken({ algorithm: "RS512" }))).ok).toBe(
      true,
    );
    expect(jwksRequests).toBe(2);
  });

  it("does not join an in-flight JWK Set refresh for a different accepted signing-algorithm intersection", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    let providerConfigurationRequests = 0;
    let jwksRequests = 0;
    let resolveSecondJwksFetch: ((response: Response) => void) | undefined;
    let signalSecondJwksFetch: (() => void) | undefined;
    const secondJwksFetchStarted = new Promise<void>((resolve) => {
      signalSecondJwksFetch = resolve;
    });
    const algorithmRegistration = createOidcProviderRegistration({
      acceptedIdTokenSigningAlgorithms: ["RS256", "RS512"],
      idTokenProfile: { validate: () => true },
      issuer,
    });
    const fetchOidcRemoteDocumentResponse = vi.fn<typeof fetch>(async (input) => {
      const url = new Request(input).url;

      if (url === `${issuer}/.well-known/openid-configuration`) {
        providerConfigurationRequests += 1;

        return Response.json(
          {
            id_token_signing_alg_values_supported: [
              ...(providerConfigurationRequests < 3 ? [] : ["RS512"]),
              "RS256",
            ],
            issuer,
            jwks_uri: jwksUri,
          },
          {
            headers: {
              "cache-control": providerConfigurationRequests === 2 ? "max-age=0" : "max-age=1",
            },
          },
        );
      }

      if (url === jwksUri) {
        jwksRequests += 1;

        if (jwksRequests === 2) {
          signalSecondJwksFetch?.();

          return new Promise<Response>((resolve) => {
            resolveSecondJwksFetch = resolve;
          });
        }

        return Response.json(
          {
            keys: [{ ...testPublicJwk, alg: jwksRequests === 1 ? "RS256" : "RS512" }],
          },
          { headers: { "cache-control": "max-age=1" } },
        );
      }

      return new Response(null, { status: 404 });
    });
    const verifier = testVerifier(
      fetchOidcRemoteDocumentResponse,
      () => now,
      algorithmRegistration,
    );

    expect((await verifier.verifyIdToken(await signedIdToken())).ok).toBe(true);
    now = new Date("2026-01-01T00:00:02Z");

    const rs256Authentication = verifier.verifyIdToken(await signedIdToken());
    await secondJwksFetchStarted;
    const rs512Authentication = verifier.verifyIdToken(await signedIdToken({ algorithm: "RS512" }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    if (resolveSecondJwksFetch === undefined) {
      throw new Error("expected the RS256 JWKS refresh to be in flight");
    }

    resolveSecondJwksFetch(
      Response.json(
        { keys: [{ ...testPublicJwk, alg: "RS256" }] },
        { headers: { "cache-control": "max-age=1" } },
      ),
    );

    expect((await rs256Authentication).ok).toBe(true);
    expect((await rs512Authentication).ok).toBe(true);
    expect(jwksRequests).toBe(3);
  });

  it("does not reuse an in-flight JWKS refresh after metadata changes its URI", async () => {
    const replacementJwksUri = "https://keys.example/tenant/replacement-jwks";
    let now = new Date("2026-01-01T00:00:00Z");
    let providerConfigurationRequests = 0;
    let oldJwksRequests = 0;
    let resolveSecondOldJwksFetch: ((response: Response) => void) | undefined;
    let signalSecondOldJwksFetch: (() => void) | undefined;
    const secondOldJwksFetchStarted = new Promise<void>((resolve) => {
      signalSecondOldJwksFetch = resolve;
    });
    const fetchOidcRemoteDocumentResponse = vi.fn<typeof fetch>(async (input) => {
      const url = new Request(input).url;

      if (url === `${issuer}/.well-known/openid-configuration`) {
        providerConfigurationRequests += 1;

        return Response.json(
          {
            id_token_signing_alg_values_supported: ["RS256"],
            issuer,
            jwks_uri: providerConfigurationRequests < 3 ? jwksUri : replacementJwksUri,
          },
          {
            headers: {
              "cache-control": providerConfigurationRequests === 2 ? "max-age=0" : "max-age=1",
            },
          },
        );
      }

      if (url === jwksUri) {
        oldJwksRequests += 1;

        if (oldJwksRequests === 2) {
          signalSecondOldJwksFetch?.();

          return new Promise<Response>((resolve) => {
            resolveSecondOldJwksFetch = resolve;
          });
        }

        return Response.json(
          { keys: [testPublicJwk] },
          { headers: { "cache-control": "max-age=1" } },
        );
      }

      if (url === replacementJwksUri) {
        return Response.json({ keys: [] }, { headers: { "cache-control": "max-age=1" } });
      }

      return new Response(null, { status: 404 });
    });
    const verifier = testVerifier(fetchOidcRemoteDocumentResponse, () => now);
    const subjectToken = await signedIdToken();

    expect((await verifier.verifyIdToken(subjectToken)).ok).toBe(true);
    now = new Date("2026-01-01T00:00:02Z");

    const oldMetadataRequest = verifier.verifyIdToken(subjectToken);
    await secondOldJwksFetchStarted;
    const replacementMetadataRequest = verifier.verifyIdToken(subjectToken);

    await new Promise((resolve) => setTimeout(resolve, 0));

    if (resolveSecondOldJwksFetch === undefined) {
      throw new Error("expected the old JWKS refresh to be in flight");
    }

    resolveSecondOldJwksFetch(
      Response.json({ keys: [testPublicJwk] }, { headers: { "cache-control": "max-age=1" } }),
    );

    expect((await oldMetadataRequest).ok).toBe(true);
    await expect(replacementMetadataRequest).resolves.toEqual(
      expectedFailure("provider_unavailable", "ERR_OIDC_JWKS_NO_USABLE_VERIFICATION_KEY"),
    );
    expect(
      fetchOidcRemoteDocumentResponse.mock.calls.map(([input]) => new Request(input).url),
    ).toContain(replacementJwksUri);
  });

  it("accepts the registered JWK Set media type", async () => {
    const verifier = testVerifier(providerFetch({ jwksContentType: "application/jwk-set+json" }));

    expect((await verifier.verifyIdToken(await signedIdToken())).ok).toBe(true);
  });

  it.each([
    {
      byteLimit: 64 * 1024,
      expectedPulls: 65,
      documentName: "Provider Configuration",
      failureKind: "subject_token_rejected",
      testVerifier: (response: Response) =>
        testVerifier(providerFetch({ providerConfigurationResponse: () => response })),
    },
    {
      byteLimit: 256 * 1024,
      expectedPulls: 257,
      documentName: "JWK Set",
      failureKind: "provider_unavailable",
      testVerifier: (response: Response) =>
        testVerifier(providerFetch({ jwksResponse: () => response })),
    },
  ])(
    "stops reading an oversized chunked $documentName response at its byte limit",
    async ({ byteLimit, expectedPulls, failureKind, testVerifier }) => {
      const streamedResponse = streamedJsonResponse({
        chunkCount: expectedPulls + 64,
        chunkSize: 1024,
        declaredLength: 2,
      });

      await expect(
        testVerifier(streamedResponse.response).verifyIdToken(await signedIdToken()),
      ).resolves.toMatchObject({
        failure: {
          diagnostics: {
            diagnosticCode:
              failureKind === "subject_token_rejected"
                ? "ERR_OIDC_METADATA_INVALID"
                : expect.stringMatching(/_RESPONSE_LIMIT_EXCEEDED$/u),
          },
          kind: failureKind,
        },
        ok: false,
      });
      expect(streamedResponse.pulledBytes()).toBe(byteLimit + 1024);
      expect(streamedResponse.pullCount()).toBe(expectedPulls);
      expect(streamedResponse.cancelCount()).toBe(1);
    },
  );

  it.each([
    {
      bodyLength: 64 * 1024,
      documentName: "Provider Configuration",
      testVerifier: (response: Response) =>
        testVerifier(providerFetch({ providerConfigurationResponse: () => response })),
      value: {
        id_token_signing_alg_values_supported: ["RS256"],
        issuer,
        jwks_uri: jwksUri,
      },
    },
    {
      bodyLength: 256 * 1024,
      documentName: "JWK Set",
      testVerifier: (response: Response) =>
        testVerifier(providerFetch({ jwksResponse: () => response })),
      value: { keys: [testPublicJwk] },
    },
  ])(
    "accepts a valid $documentName response exactly at its byte limit",
    async ({ bodyLength, testVerifier, value }) => {
      const response = jsonResponseWithExactBodyLength(value, bodyLength);

      await expect(
        testVerifier(response).verifyIdToken(await signedIdToken()),
      ).resolves.toMatchObject({ ok: true });
    },
  );

  it("classifies a Provider Configuration response with a body transport failure as unavailable", async () => {
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(
            Object.assign(new Error("provider body unavailable"), {
              name: "NetworkError",
            }),
          );
        },
      }),
      { headers: { "content-type": "application/json" } },
    );

    await expect(
      testVerifier(providerFetch({ providerConfigurationResponse: () => response })).verifyIdToken(
        await signedIdToken(),
      ),
    ).resolves.toEqual(
      expectedFailure("provider_unavailable", "ERR_OIDC_PROVIDER_CONFIGURATION_FETCH_FAILED"),
    );
  });

  it.each([
    {
      diagnosticCode: "ERR_OIDC_PROVIDER_CONFIGURATION_TIMEOUT",
      documentName: "Provider Configuration",
      providerResponse: (response: Response) =>
        providerFetch({ providerConfigurationResponse: () => response }),
    },
    {
      diagnosticCode: "ERR_OIDC_JWKS_TIMEOUT",
      documentName: "JWK Set",
      providerResponse: (response: Response) => providerFetch({ jwksResponse: () => response }),
    },
  ])(
    "cancels a stalled $documentName body and classifies the deadline as provider unavailability",
    async ({ diagnosticCode, providerResponse }) => {
      const timeoutControllers: AbortController[] = [];
      const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
        const controller = new AbortController();
        timeoutControllers.push(controller);

        return controller.signal;
      });
      const cancel = vi.fn();
      const bodyRead = Promise.withResolvers<void>();
      const response = new Response(
        new ReadableStream(
          {
            cancel,
            pull() {
              bodyRead.resolve();

              return new Promise<void>(() => undefined);
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "application/json" } },
      );

      try {
        const authentication = testVerifier(providerResponse(response)).verifyIdToken(
          await signedIdToken(),
        );
        await bodyRead.promise;
        expect(timeout).toHaveBeenLastCalledWith(5_000);
        const deadline = new DOMException("OIDC provider deadline exceeded", "TimeoutError");
        const timeoutController = timeoutControllers.at(-1);

        if (timeoutController === undefined) {
          throw new Error("expected an OIDC provider request timeout signal");
        }

        timeoutController.abort(deadline);

        await expect(authentication).resolves.toEqual(
          expectedFailure("provider_unavailable", diagnosticCode),
        );
        expect(cancel).toHaveBeenCalledOnce();
        expect(cancel).toHaveBeenCalledWith(deadline);
      } finally {
        timeout.mockRestore();
      }
    },
  );

  it.each([
    [
      "a timeout",
      () => Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })),
      "ERR_OIDC_PROVIDER_CONFIGURATION_TIMEOUT",
      undefined,
      "provider_unavailable",
    ],
    [
      "a network failure",
      () => Promise.reject(new Error("network unavailable")),
      "ERR_OIDC_PROVIDER_CONFIGURATION_FETCH_FAILED",
      undefined,
      "provider_unavailable",
    ],
    [
      "a non-success status",
      () => Promise.resolve(new Response(null, { status: 429 })),
      "ERR_OIDC_PROVIDER_CONFIGURATION_HTTP_STATUS",
      429,
      "provider_unavailable",
    ],
    [
      "an unexpected media type",
      () =>
        Promise.resolve(
          new Response("{}", {
            headers: { "content-type": "text/plain" },
          }),
        ),
      "ERR_OIDC_METADATA_INVALID",
      undefined,
      "subject_token_rejected",
    ],
    [
      "an excessive declared length",
      () =>
        Promise.resolve(
          new Response("{}", {
            headers: {
              "content-length": String(64 * 1024 + 1),
              "content-type": "application/json",
            },
          }),
        ),
      "ERR_OIDC_METADATA_INVALID",
      undefined,
      "subject_token_rejected",
    ],
    [
      "an excessive body",
      () =>
        Promise.resolve(
          new Response(" ".repeat(64 * 1024 + 1), {
            headers: { "content-type": "application/json" },
          }),
        ),
      "ERR_OIDC_METADATA_INVALID",
      undefined,
      "subject_token_rejected",
    ],
    [
      "malformed JSON",
      () =>
        Promise.resolve(
          new Response("{", {
            headers: { "content-type": "application/json" },
          }),
        ),
      "ERR_OIDC_METADATA_INVALID",
      undefined,
      "subject_token_rejected",
    ],
  ] as const)(
    "classifies a Provider Configuration response with %s",
    async (
      _description,
      fetchOidcRemoteDocumentResponse,
      diagnosticCode,
      providerHttpStatus,
      failureKind,
    ) => {
      await expect(
        testVerifier(fetchOidcRemoteDocumentResponse).verifyIdToken(await signedIdToken()),
      ).resolves.toEqual(expectedFailure(failureKind, diagnosticCode, providerHttpStatus));
    },
  );

  it.each([
    ["a missing keys member", Response.json({}), "ERR_OIDC_JWKS_INVALID"],
    ["a non-object key", Response.json({ keys: ["invalid"] }), "ERR_OIDC_JWKS_INVALID"],
    [
      "a key without kty",
      Response.json({ keys: [{ ...testPublicJwk, kty: undefined }] }),
      "ERR_OIDC_JWKS_INVALID",
    ],
    [
      "a non-string alg",
      Response.json({ keys: [{ ...testPublicJwk, alg: ["RS256"] }] }),
      "ERR_OIDC_JWKS_INVALID",
    ],
    [
      "a non-string use",
      Response.json({ keys: [{ ...testPublicJwk, use: false }] }),
      "ERR_OIDC_JWKS_INVALID",
    ],
    [
      "a non-string kid",
      Response.json({ keys: [{ ...testPublicJwk, kid: 1 }] }),
      "ERR_OIDC_JWKS_INVALID",
    ],
    [
      "non-array key_ops",
      Response.json({ keys: [{ ...testPublicJwk, key_ops: "verify" }] }),
      "ERR_OIDC_JWKS_INVALID",
    ],
    [
      "a non-string key_ops member",
      Response.json({ keys: [{ ...testPublicJwk, key_ops: ["verify", 1] }] }),
      "ERR_OIDC_JWKS_INVALID",
    ],
    [
      "non-array x5c",
      Response.json({ keys: [{ ...testPublicJwk, x5c: "certificate" }] }),
      "ERR_OIDC_JWKS_INVALID",
    ],
    [
      "a non-string x5c member",
      Response.json({ keys: [{ ...testPublicJwk, x5c: ["certificate", 1] }] }),
      "ERR_OIDC_JWKS_INVALID",
    ],
    [
      "no usable verification key",
      Response.json({ keys: [] }),
      "ERR_OIDC_JWKS_NO_USABLE_VERIFICATION_KEY",
    ],
    [
      "only a key for an unaccepted algorithm",
      Response.json({ keys: [{ ...testPublicJwk, alg: "RS512" }] }),
      "ERR_OIDC_JWKS_NO_USABLE_VERIFICATION_KEY",
    ],
    [
      "only a key restricted to encryption use",
      Response.json({ keys: [{ ...testPublicJwk, use: "enc" }] }),
      "ERR_OIDC_JWKS_NO_USABLE_VERIFICATION_KEY",
    ],
    [
      "only a key without verification operations",
      Response.json({ keys: [{ ...testPublicJwk, key_ops: ["encrypt"] }] }),
      "ERR_OIDC_JWKS_NO_USABLE_VERIFICATION_KEY",
    ],
    [
      "only a key of an incompatible type",
      Response.json({ keys: [{ ...testPublicJwk, kty: "EC" }] }),
      "ERR_OIDC_JWKS_NO_USABLE_VERIFICATION_KEY",
    ],
    [
      "too many keys",
      Response.json({ keys: Array.from({ length: 201 }, () => ({})) }),
      "ERR_OIDC_JWKS_KEY_LIMIT_EXCEEDED",
    ],
    [
      "an unexpected media type",
      new Response(JSON.stringify({ keys: [testPublicJwk] }), {
        headers: { "content-type": "text/plain" },
      }),
      "ERR_OIDC_JWKS_CONTENT_TYPE_INVALID",
    ],
  ] as const)("rejects a JWKS with %s", async (_description, response, diagnosticCode) => {
    const fetchOidcRemoteDocumentResponse = providerFetch({ jwksResponse: () => response.clone() });

    await expect(
      testVerifier(fetchOidcRemoteDocumentResponse).verifyIdToken(await signedIdToken()),
    ).resolves.toEqual(expectedFailure("provider_unavailable", diagnosticCode));
  });

  it("classifies an unusable matching provider key as provider unavailability", async () => {
    const fetchOidcRemoteDocumentResponse = providerFetch({
      jwksResponse: () =>
        Response.json({
          keys: [{ alg: "RS256", kid: "test-key-1", kty: "RSA" }],
        }),
    });

    await expect(
      testVerifier(fetchOidcRemoteDocumentResponse).verifyIdToken(await signedIdToken()),
    ).resolves.toEqual(
      expectedFailure("provider_unavailable", "ERR_OIDC_JWKS_NO_USABLE_VERIFICATION_KEY"),
    );
  });

  it("classifies a provider-selected non-public key as provider unavailability", async () => {
    const privateJwk = createPrivateKey(testPrivateKeyPem).export({ format: "jwk" });
    const fetchOidcRemoteDocumentResponse = providerFetch({
      jwksResponse: () =>
        Response.json({
          keys: [
            { ...testPublicJwk, kid: "other-usable-key" },
            { ...privateJwk, kid: "test-key-1" },
          ],
        }),
    });

    await expect(
      testVerifier(fetchOidcRemoteDocumentResponse).verifyIdToken(await signedIdToken()),
    ).resolves.toEqual(expectedFailure("provider_unavailable", "ERR_OIDC_JWKS_KEY_INVALID"));
  });

  it("classifies duplicate matching provider keys as provider unavailability", async () => {
    const fetchOidcRemoteDocumentResponse = providerFetch({
      jwksResponse: () => Response.json({ keys: [testPublicJwk, testPublicJwk] }),
    });

    await expect(
      testVerifier(fetchOidcRemoteDocumentResponse).verifyIdToken(await signedIdToken()),
    ).resolves.toEqual(expectedFailure("provider_unavailable", "ERR_OIDC_JWKS_KEY_INVALID"));
  });

  it("backs off a failed Provider Configuration fetch when no metadata is cached", async () => {
    const fetchOidcRemoteDocumentResponse = vi.fn(async () => new Response(null, { status: 503 }));
    const events: OidcIdTokenAuthenticationEvent[] = [];
    const observe = (event: OidcIdTokenAuthenticationEvent) => events.push(event);
    const verifier = testVerifier(fetchOidcRemoteDocumentResponse);
    const subjectToken = await signedIdToken();
    const diagnosticCode = "ERR_OIDC_PROVIDER_CONFIGURATION_HTTP_STATUS";
    const expectedResult = expectedFailure("provider_unavailable", diagnosticCode, 503);

    await expect(verifier.verifyIdToken(subjectToken, observe)).resolves.toEqual(expectedResult);
    await expect(verifier.verifyIdToken(subjectToken, observe)).resolves.toEqual(expectedResult);
    expect(fetchOidcRemoteDocumentResponse).toHaveBeenCalledOnce();
    expect(events).toEqual([
      {
        diagnosticCode,
        remoteDocumentKind: "provider_configuration",
        event: "oidc_remote_document_refresh_failed",
        issuer: registration.issuer,
        providerHttpStatus: 503,
      },
    ]);
  });

  it("backs off a failed JWKS fetch when no last-known-good document exists", async () => {
    const fetchOidcRemoteDocumentResponse = vi.fn(
      providerFetch({
        jwksResponse: () => new Response(null, { status: 503 }),
      }),
    );
    const verifier = testVerifier(fetchOidcRemoteDocumentResponse);
    const subjectToken = await signedIdToken();

    await expect(verifier.verifyIdToken(subjectToken)).resolves.toEqual(
      expectedFailure("provider_unavailable", "ERR_OIDC_JWKS_HTTP_STATUS", 503),
    );
    await expect(verifier.verifyIdToken(subjectToken)).resolves.toEqual(
      expectedFailure("provider_unavailable", "ERR_OIDC_JWKS_HTTP_STATUS", 503),
    );
    expect(fetchOidcRemoteDocumentResponse).toHaveBeenCalledTimes(2);
  });

  it("does not retain Provider Configuration and JWKS responses marked no-store", async () => {
    const fetchOidcRemoteDocumentResponse = vi.fn(providerFetch({ cacheControl: "no-store" }));
    const verifier = testVerifier(fetchOidcRemoteDocumentResponse);
    const subjectToken = await signedIdToken();

    expect((await verifier.verifyIdToken(subjectToken)).ok).toBe(true);
    expect((await verifier.verifyIdToken(subjectToken)).ok).toBe(true);
    expect(fetchOidcRemoteDocumentResponse).toHaveBeenCalledTimes(4);
  });

  it("revalidates Provider Configuration and JWKS responses marked no-cache", async () => {
    const fetchOidcRemoteDocumentResponse = vi.fn(providerFetch({ cacheControl: "no-cache" }));
    const verifier = testVerifier(fetchOidcRemoteDocumentResponse);
    const subjectToken = await signedIdToken();

    expect((await verifier.verifyIdToken(subjectToken)).ok).toBe(true);
    expect((await verifier.verifyIdToken(subjectToken)).ok).toBe(true);
    expect(fetchOidcRemoteDocumentResponse).toHaveBeenCalledTimes(4);
  });

  it("does not use stale Provider Configuration marked no-cache after failed revalidation", async () => {
    let available = true;
    const fetchOidcRemoteDocumentResponse = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      available
        ? providerFetch({ cacheControl: "no-cache" })(input, init)
        : Promise.resolve(new Response(null, { status: 503 })),
    );
    const verifier = testVerifier(fetchOidcRemoteDocumentResponse);
    const subjectToken = await signedIdToken();

    expect((await verifier.verifyIdToken(subjectToken)).ok).toBe(true);
    available = false;
    await expect(verifier.verifyIdToken(subjectToken)).resolves.toEqual(
      expectedFailure("provider_unavailable", "ERR_OIDC_PROVIDER_CONFIGURATION_HTTP_STATUS", 503),
    );
    expect(fetchOidcRemoteDocumentResponse).toHaveBeenCalledTimes(3);
  });

  it("does not use stale JWKS marked no-cache after failed revalidation", async () => {
    let jwksAvailable = true;
    const fetchOidcRemoteDocumentResponse = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        if (new Request(input).url === jwksUri && !jwksAvailable) {
          return Promise.resolve(new Response(null, { status: 503 }));
        }

        return providerFetch({ cacheControl: "no-cache" })(input, init);
      },
    );
    const verifier = testVerifier(fetchOidcRemoteDocumentResponse);
    const subjectToken = await signedIdToken();

    expect((await verifier.verifyIdToken(subjectToken)).ok).toBe(true);
    jwksAvailable = false;
    await expect(verifier.verifyIdToken(subjectToken)).resolves.toEqual(
      expectedFailure("provider_unavailable", "ERR_OIDC_JWKS_HTTP_STATUS", 503),
    );
    expect(fetchOidcRemoteDocumentResponse).toHaveBeenCalledTimes(4);
  });

  it("does not use stale Provider Configuration marked must-revalidate", async () => {
    let available = true;
    const fetchOidcRemoteDocumentResponse = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      available
        ? providerFetch({ cacheControl: "max-age=0, must-revalidate" })(input, init)
        : Promise.resolve(new Response(null, { status: 503 })),
    );
    const verifier = testVerifier(fetchOidcRemoteDocumentResponse);
    const subjectToken = await signedIdToken();

    expect((await verifier.verifyIdToken(subjectToken)).ok).toBe(true);
    available = false;
    await expect(verifier.verifyIdToken(subjectToken)).resolves.toEqual(
      expectedFailure("provider_unavailable", "ERR_OIDC_PROVIDER_CONFIGURATION_HTTP_STATUS", 503),
    );
  });

  it("does not use stale JWKS marked must-revalidate", async () => {
    let jwksAvailable = true;
    const events: OidcIdTokenAuthenticationEvent[] = [];
    const fetchOidcRemoteDocumentResponse = vi.fn(
      providerFetch({
        jwksResponse: () =>
          jwksAvailable
            ? Response.json(
                { keys: [testPublicJwk] },
                { headers: { "cache-control": "max-age=0, must-revalidate" } },
              )
            : new Response(null, { status: 503 }),
      }),
    );
    const observe = (event: OidcIdTokenAuthenticationEvent) => events.push(event);
    const verifier = testVerifier(fetchOidcRemoteDocumentResponse);
    const subjectToken = await signedIdToken();

    expect((await verifier.verifyIdToken(subjectToken, observe)).ok).toBe(true);
    jwksAvailable = false;
    await expect(verifier.verifyIdToken(subjectToken, observe)).resolves.toEqual(
      expectedFailure("provider_unavailable", "ERR_OIDC_JWKS_HTTP_STATUS", 503),
    );
    expect(
      fetchOidcRemoteDocumentResponse.mock.calls.filter(
        ([input]) => new Request(input).url === `${issuer}/.well-known/openid-configuration`,
      ),
    ).toHaveLength(1);
    expect(
      fetchOidcRemoteDocumentResponse.mock.calls.filter(
        ([input]) => new Request(input).url === jwksUri,
      ),
    ).toHaveLength(2);
    expect(
      events.filter(
        (event) =>
          event.event === "oidc_remote_document_stale_used" &&
          event.remoteDocumentKind === "jwk_set",
      ),
    ).toEqual([]);
  });

  it("uses bounded last-known-good Provider Metadata and JWKS only for provider unavailability", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    let available = true;
    const fetchOidcRemoteDocumentResponse = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      available
        ? successfulProviderFetch(input, init)
        : Promise.resolve(new Response(null, { status: 503 })),
    );
    const verifier = testVerifier(fetchOidcRemoteDocumentResponse, () => now);
    const subjectToken = await signedIdToken({ expiresInSeconds: 7_200 });

    expect((await verifier.verifyIdToken(subjectToken)).ok).toBe(true);
    available = false;
    now = new Date("2026-01-01T00:06:00Z");
    expect((await verifier.verifyIdToken(subjectToken)).ok).toBe(true);
    const callsAfterFirstFailure = fetchOidcRemoteDocumentResponse.mock.calls.length;
    expect((await verifier.verifyIdToken(subjectToken)).ok).toBe(true);
    expect(fetchOidcRemoteDocumentResponse).toHaveBeenCalledTimes(callsAfterFirstFailure);
    now = new Date("2026-01-01T01:06:01Z");
    await expect(verifier.verifyIdToken(subjectToken)).resolves.toEqual(
      expectedFailure("provider_unavailable", "ERR_OIDC_PROVIDER_CONFIGURATION_HTTP_STATUS", 503),
    );
  });

  it("rejects invalid refreshed Provider Metadata without using a stale cache entry", async () => {
    let providerConfigurationRequests = 0;
    const fetchOidcRemoteDocumentResponse = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);

        if (request.url === `${issuer}/.well-known/openid-configuration`) {
          providerConfigurationRequests += 1;

          if (providerConfigurationRequests > 1) {
            return Promise.resolve(
              Response.json({
                id_token_signing_alg_values_supported: ["ES256"],
                issuer,
                jwks_uri: jwksUri,
              }),
            );
          }
        }

        return providerFetch({ cacheControl: "max-age=0" })(request);
      },
    );
    const verifier = testVerifier(fetchOidcRemoteDocumentResponse);
    const subjectToken = await signedIdToken();

    expect((await verifier.verifyIdToken(subjectToken)).ok).toBe(true);
    await expect(verifier.verifyIdToken(subjectToken)).resolves.toEqual(
      expectedFailure("subject_token_rejected", "ERR_OIDC_METADATA_INVALID"),
    );
    const callsAfterInvalidMetadata = fetchOidcRemoteDocumentResponse.mock.calls.length;
    await expect(verifier.verifyIdToken(subjectToken)).resolves.toEqual(
      expectedFailure("subject_token_rejected", "ERR_OIDC_METADATA_INVALID"),
    );
    expect(fetchOidcRemoteDocumentResponse).toHaveBeenCalledTimes(callsAfterInvalidMetadata);
  });

  it("rejects malformed refreshed Provider Configuration without using a stale cache entry", async () => {
    let providerConfigurationRequests = 0;
    const fetchOidcRemoteDocumentResponse = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);

        if (request.url === `${issuer}/.well-known/openid-configuration`) {
          providerConfigurationRequests += 1;

          if (providerConfigurationRequests > 1) {
            return Promise.resolve(
              new Response("{", { headers: { "content-type": "application/json" } }),
            );
          }
        }

        return providerFetch({ cacheControl: "max-age=0" })(request);
      },
    );
    const verifier = testVerifier(fetchOidcRemoteDocumentResponse);
    const subjectToken = await signedIdToken();

    expect((await verifier.verifyIdToken(subjectToken)).ok).toBe(true);
    await expect(verifier.verifyIdToken(subjectToken)).resolves.toEqual(
      expectedFailure("subject_token_rejected", "ERR_OIDC_METADATA_INVALID"),
    );
    const callsAfterMalformedMetadata = fetchOidcRemoteDocumentResponse.mock.calls.length;
    await expect(verifier.verifyIdToken(subjectToken)).resolves.toEqual(
      expectedFailure("subject_token_rejected", "ERR_OIDC_METADATA_INVALID"),
    );
    expect(fetchOidcRemoteDocumentResponse).toHaveBeenCalledTimes(callsAfterMalformedMetadata);
  });

  it("runs the OIDC ID Token Profile only after central verification", async () => {
    const validate = vi.fn(() => false);
    const profileRegistration = createOidcProviderRegistration({
      acceptedIdTokenSigningAlgorithms: ["RS256"],
      idTokenProfile: { validate },
      issuer,
    });
    const verifier = testVerifier(successfulProviderFetch, undefined, profileRegistration);

    await expect(verifier.verifyIdToken(await signedIdToken())).resolves.toEqual(
      expectedFailure("subject_token_rejected", "ERR_OIDC_ID_TOKEN_PROFILE_REJECTED"),
    );
    expect(validate).toHaveBeenCalledOnce();
  });

  it("classifies an unexpected OIDC ID Token Profile failure as internal", async () => {
    const profileRegistration = createOidcProviderRegistration({
      acceptedIdTokenSigningAlgorithms: ["RS256"],
      idTokenProfile: {
        validate: () => {
          throw new Error("unexpected profile failure");
        },
      },
      issuer,
    });
    const verifier = testVerifier(successfulProviderFetch, undefined, profileRegistration);

    await expect(verifier.verifyIdToken(await signedIdToken())).resolves.toEqual(
      expectedFailure("internal_failure"),
    );
  });
});

async function beginCoalescedJwksRefreshFailure(
  observe: (event: OidcIdTokenAuthenticationEvent) => void,
) {
  let now = new Date("2026-01-01T00:00:00Z");
  let jwksRequests = 0;
  const failedRefresh = Promise.withResolvers<Response>();
  const refreshStarted = Promise.withResolvers<void>();
  const fetchOidcRemoteDocumentResponse = vi.fn<typeof fetch>((input) => {
    const url = new Request(input).url;

    if (url === `${issuer}/.well-known/openid-configuration`) {
      return Promise.resolve(providerConfigurationResponse("max-age=300"));
    }

    if (url === jwksUri) {
      jwksRequests += 1;

      if (jwksRequests === 1) {
        return Promise.resolve(
          Response.json({ keys: [testPublicJwk] }, { headers: { "cache-control": "max-age=1" } }),
        );
      }

      refreshStarted.resolve();
      return failedRefresh.promise;
    }

    return Promise.resolve(new Response(null, { status: 404 }));
  });
  const verifier = testVerifier(fetchOidcRemoteDocumentResponse, () => now);
  const subjectToken = await signedIdToken();

  await expect(verifier.verifyIdToken(subjectToken, observe)).resolves.toMatchObject({
    ok: true,
  });
  now = new Date(now.getTime() + 1_001);
  const results = Promise.all([
    verifier.verifyIdToken(subjectToken, observe),
    verifier.verifyIdToken(subjectToken, observe),
  ]);
  await refreshStarted.promise;

  return {
    verifier,
    failedRefresh,
    jwksRequests: () => jwksRequests,
    results,
    subjectToken,
  };
}

function testVerifier(
  fetchOidcRemoteDocumentResponse: typeof fetch,
  now: () => Date = () => authenticationTestNow,
  providerRegistration: OidcProviderRegistration = registration,
): RegisteredOidcProviderVerifier {
  return createRegisteredOidcProviderVerifier({
    dependencies: { fetch: fetchOidcRemoteDocumentResponse, now },
    providerRegistration,
    subjectTokenAudience,
  });
}

function oidcRedirectResponse(): Response {
  return new Response(null, {
    headers: { location: "https://attacker.example/oidc-document" },
    status: 302,
  });
}

function providerConfigurationResponse(
  cacheControl: string,
  responseJwksUri: string = jwksUri,
): Response {
  return Response.json(
    {
      id_token_signing_alg_values_supported: ["RS256"],
      issuer,
      jwks_uri: responseJwksUri,
    },
    { headers: { "cache-control": cacheControl } },
  );
}

function jsonResponseWithExactBodyLength(value: unknown, bodyLength: number): Response {
  const json = JSON.stringify(value);
  const paddingLength = bodyLength - new TextEncoder().encode(json).byteLength;

  if (paddingLength < 0) {
    throw new Error("JSON value exceeds requested response body length");
  }

  return new Response(`${json}${" ".repeat(paddingLength)}`, {
    headers: { "content-type": "application/json" },
  });
}

function streamedJsonResponse(options: {
  chunkCount: number;
  chunkSize: number;
  declaredLength?: number;
}): {
  cancelCount(): number;
  pullCount(): number;
  pulledBytes(): number;
  response: Response;
} {
  let cancellations = 0;
  let pulls = 0;
  const response = new Response(
    new ReadableStream(
      {
        cancel() {
          cancellations += 1;
        },
        pull(controller) {
          if (pulls === options.chunkCount) {
            controller.close();

            return;
          }

          pulls += 1;
          controller.enqueue(new Uint8Array(options.chunkSize).fill(0x20));
        },
      },
      { highWaterMark: 0 },
    ),
    {
      headers: {
        ...(options.declaredLength === undefined
          ? {}
          : { "content-length": String(options.declaredLength) }),
        "content-type": "application/json",
      },
    },
  );

  return {
    cancelCount: () => cancellations,
    pullCount: () => pulls,
    pulledBytes: () => pulls * options.chunkSize,
    response,
  };
}
