import { createGitHubAppTokenExchange } from "@github-app-token-broker/token-exchange";
import { githubActionsOidcProviderRegistration } from "@github-app-token-broker/oidc-provider-github-actions";
import { compileTokenIssuancePolicy } from "@github-app-token-broker/token-issuance-policy";
import { decodeJwt } from "jose";
import { describe, expect, it, vi } from "vitest";

import { testInstallationId, testRepository } from "./support/constants.ts";
import { tokenExchangeRequestBody } from "./support/oidc.ts";
import { testPrivateKeyPem } from "./support/rsa-test-key-pair.ts";
import { testTokenIssuancePolicy } from "./support/token-issuance-policy.ts";
import { createTokenExchangeEndpoint } from "../packages/token-exchange/src/token-exchange.ts";
import type { ExchangeInstallationAccessToken } from "../packages/token-exchange/src/installation-access-token-exchange.ts";
import { mustNormalizeTokenRequest } from "./support/installation-access-token-request.ts";

describe("createGitHubAppTokenExchange", () => {
  it("exposes method and request validation through its runtime-neutral handler", async () => {
    const fetchExternal = vi.fn<typeof fetch>();
    const tokenExchange = createGitHubAppTokenExchange(
      {
        composition: {
          oidcProviderRegistrations: [],
          tokenIssuancePolicy: compileTokenIssuancePolicy([]),
        },
        githubApp: { appId: "test", privateKey: "unused" },
        subjectTokenAudience: "https://broker.example",
      },
      { fetch: fetchExternal, now: () => new Date("2026-01-01T00:00:00Z") },
    );
    const observe = vi.fn();

    const methodResponse = await tokenExchange(new Request("https://broker.example/token"), {
      observe,
    });
    expect(methodResponse.status).toBe(400);
    await expect(methodResponse.json()).resolves.toEqual({ error: "invalid_request" });

    const contentTypeResponse = await tokenExchange(
      new Request("https://broker.example/token", { body: "ignored", method: "POST" }),
      { observe },
    );
    expect(contentTypeResponse.status).toBe(400);
    await expect(contentTypeResponse.json()).resolves.toEqual({ error: "invalid_request" });
    expect(observe).not.toHaveBeenCalled();
    expect(fetchExternal).not.toHaveBeenCalled();
  });

  it("validates explicit audience and composition during construction", () => {
    expect(() =>
      createGitHubAppTokenExchange({
        composition: {
          oidcProviderRegistrations: [],
          tokenIssuancePolicy: compileTokenIssuancePolicy([]),
        },
        githubApp: { appId: "test", privateKey: "unused" },
        subjectTokenAudience: " ",
      }),
    ).toThrow("subjectTokenAudience is required");
  });

  it("snapshots GitHub App configuration during construction", async () => {
    const githubApp = {
      apiBaseUrl: "https://github-original.example",
      appId: "original-app-id",
      privateKey: testPrivateKeyPem,
    };
    const requestedUrls: string[] = [];
    const observedJwtIssuers: unknown[] = [];
    const tokenExchange = createGitHubAppTokenExchange(
      {
        composition: {
          oidcProviderRegistrations: [githubActionsOidcProviderRegistration],
          tokenIssuancePolicy: testTokenIssuancePolicy,
        },
        githubApp,
        subjectTokenAudience: "https://broker.example",
      },
      {
        fetch: async (input, init) => {
          const request = new Request(input, init);

          if (request.url.startsWith("https://github-original.example/")) {
            requestedUrls.push(request.url);
            const authorization = request.headers.get("authorization");
            observedJwtIssuers.push(
              authorization === null
                ? undefined
                : decodeJwt(authorization.slice("Bearer ".length)).iss,
            );

            if (request.method === "GET") {
              return Response.json({ account: { login: "fixture-owner" }, id: testInstallationId });
            }

            return Response.json(
              {
                expires_at: "2030-01-01T00:00:00Z",
                permissions: { contents: "write", pull_requests: "write" },
                token: "ghs_snapshotted_configuration",
              },
              { status: 201 },
            );
          }

          if (request.url.endsWith("/.well-known/openid-configuration")) {
            return Response.json({
              id_token_signing_alg_values_supported: ["RS256"],
              issuer: githubActionsOidcProviderRegistration.issuer,
              jwks_uri: "https://token.actions.githubusercontent.com/.well-known/jwks",
            });
          }

          if (request.url.endsWith("/.well-known/jwks")) {
            const { testPublicJwk } = await import("./support/rsa-test-key-pair.ts");
            return Response.json({ keys: [testPublicJwk] });
          }

          return new Response(null, { status: 404 });
        },
        now: () => new Date(),
      },
    );

    githubApp.apiBaseUrl = "https://github-mutated.example";
    githubApp.appId = "mutated-app-id";
    githubApp.privateKey = "mutated-private-key";

    const response = await tokenExchange(
      new Request("https://broker.example/token", {
        body: await tokenExchangeRequestBody(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      { observe: vi.fn() },
    );

    expect(response.status).toBe(200);
    expect(requestedUrls).toEqual([
      `https://github-original.example/repos/${testRepository}/installation`,
      `https://github-original.example/app/installations/${testInstallationId}/access_tokens`,
    ]);
    expect(observedJwtIssuers).toEqual(["original-app-id", "original-app-id"]);
  });
});

describe("token exchange endpoint", () => {
  it("does not invoke the application function for a malformed request", async () => {
    const exchangeInstallationAccessToken = vi.fn<ExchangeInstallationAccessToken>();
    const tokenExchange = createTokenExchangeEndpoint(
      exchangeInstallationAccessToken,
      () => new Date("2026-01-01T00:00:00Z"),
    );

    const response = await tokenExchange(
      new Request("https://broker.example/token", { body: "grant_type=invalid", method: "POST" }),
      { observe: vi.fn() },
    );

    expect(response.status).toBe(400);
    expect(exchangeInstallationAccessToken).not.toHaveBeenCalled();
  });

  it("passes a normalized command and explicit request diagnostics to the application function", async () => {
    const exchangeInstallationAccessToken = vi.fn<ExchangeInstallationAccessToken>(async () => ({
      expiresAt: "2026-01-01T00:01:30Z",
      ok: true,
      token: "ghs_test",
    }));
    const tokenExchange = createTokenExchangeEndpoint(
      exchangeInstallationAccessToken,
      () => new Date("2026-01-01T00:00:00Z"),
    );
    const observe = vi.fn();
    const body = await tokenExchangeRequestBody();

    const response = await tokenExchange(
      new Request("https://broker.example/automation/token?ignored=true", {
        body,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "test-agent",
        },
        method: "POST",
      }),
      { observe },
    );

    expect(exchangeInstallationAccessToken).toHaveBeenCalledWith(
      {
        subjectToken: new URLSearchParams(body).get("subject_token"),
        tokenRequest: mustNormalizeTokenRequest({
          resource: "https://api.github.com/repos/fixture-owner/fixture-source-repository",
          scope: "contents:write pull_requests:write",
        }),
      },
      {
        observe,
        request: { path: "/automation/token", userAgent: "test-agent" },
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      access_token: "ghs_test",
      expires_in: 90,
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: "contents:write pull_requests:write",
      token_type: "Bearer",
    });
  });
});
