import { describe, expect, it, vi } from "vitest";

import {
  authorizationHeaders,
  fetchTokenExchange,
  fetchTokenExchangeWithDependencies,
  fetchTokenExchangeWithEnv,
  githubInstallationAccessTokenType,
  testEnv,
  tokenExchangeRequestBody,
  testTokenExchangeComposition,
  testTokenExchangeWorkerRuntimeDependencies,
} from "./support/worker.ts";
import { fetchGitHubTestDouble } from "./support/github-api.ts";
import { fetchOidcRemoteDocumentResponseTestDouble } from "./support/oidc.ts";
import { testNow } from "./support/constants.ts";
import {
  testSubjectConstraintMatchingVerifiedSubjectToken,
  testTokenIssuancePolicy,
} from "./support/token-issuance-policy.ts";
import { createTokenExchangeWorker } from "@github-app-token-broker/worker";
import {
  compileTokenIssuancePolicy,
  githubRepositoryResourceConstraint,
  oidcSubjectTokenConstraint,
} from "@github-app-token-broker/token-issuance-policy";

describe("github-app-token-broker-token-exchange", () => {
  it("rejects non-POST token requests before authentication or exchange", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      method: "GET",
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
  });

  it("maps GitHub permission validation after policy approval to 500 server_error", async () => {
    const response = await fetchTokenExchangeWithDependencies(
      "https://example.test/token",
      {
        body: await tokenExchangeRequestBody(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      },
      {
        fetch: async (input, init) => {
          const request = new Request(input, init);

          if (new URL(request.url).hostname === "token.actions.githubusercontent.com") {
            return fetchOidcRemoteDocumentResponseTestDouble(request);
          }

          return request.method === "POST"
            ? new Response("GitHub validation detail", { status: 422 })
            : fetchGitHubTestDouble(input, init);
        },
      },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "server_error" });
  });

  it("maps rejected OIDC subject tokens to invalid_request with a Bearer challenge", async () => {
    const body = new URLSearchParams(await tokenExchangeRequestBody());
    body.set("subject_token", "not-a-jwt");
    const fetchExternal = vi.fn(testTokenExchangeWorkerRuntimeDependencies.fetch);

    const response = await fetchTokenExchangeWithDependencies(
      "https://example.test/token",
      {
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      },
      { fetch: fetchExternal },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(fetchExternal).not.toHaveBeenCalled();
  });

  it("maps unavailable OIDC providers before GitHub issuance", async () => {
    const githubRequests: string[] = [];
    const response = await fetchTokenExchangeWithDependencies(
      "https://example.test/token",
      {
        body: await tokenExchangeRequestBody(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      },
      {
        fetch: async (input, init) => {
          const request = new Request(input, init);

          if (new URL(request.url).hostname === "token.actions.githubusercontent.com") {
            return new Response("provider unavailable", { status: 503 });
          }

          githubRequests.push(request.url);
          return fetchGitHubTestDouble(input, init);
        },
      },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    await expect(response.json()).resolves.toEqual({ error: "temporarily_unavailable" });
    expect(githubRequests).toEqual([]);
  });

  it("maps internal OIDC failures to server_error with a Bearer challenge", async () => {
    const fetchExternal = vi.fn(testTokenExchangeWorkerRuntimeDependencies.fetch);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const response = await fetchTokenExchangeWithDependencies(
        "https://example.test/token",
        {
          body: await tokenExchangeRequestBody(),
          headers: { "content-type": "application/x-www-form-urlencoded" },
          method: "POST",
        },
        {
          fetch: fetchExternal,
          now: () => {
            throw new Error("test clock failure");
          },
        },
      );

      expect(response.status).toBe(500);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      await expect(response.json()).resolves.toEqual({ error: "server_error" });
      expect(fetchExternal).not.toHaveBeenCalled();
      expect(consoleWarn).toHaveBeenCalledWith(
        "OIDC authentication failed",
        expect.objectContaining({ reason: "oidc_internal_failure" }),
      );
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("does not expose the removed claims endpoint", async () => {
    const response = await fetchTokenExchange("https://example.test/github/claims", {
      headers: await authorizationHeaders(),
      method: "POST",
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      status: 404,
      title: "Not Found",
      type: "about:blank",
    });
  });

  it("does not expose the legacy installation access token endpoint", async () => {
    const response = await fetchTokenExchange("https://example.test/github/installations/token", {
      headers: await authorizationHeaders(),
      method: "POST",
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      status: 404,
      title: "Not Found",
      type: "about:blank",
    });
  });

  it("exchanges a github actions oidc token at the token exchange endpoint", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody(),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    const body = (await response.json()) as {
      access_token: string;
      expires_in: number;
      issued_token_type: string;
      scope: string;
      token_type: string;
    };
    expect(body.access_token).toBe("ghs_test_token");
    expect(body.issued_token_type).toBe(githubInstallationAccessTokenType);
    expect(body.scope).toBe("contents:write pull_requests:write");
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toEqual(expect.any(Number));
    expect(body.expires_in).toBeGreaterThan(0);
  });

  it("exchanges an actions-write permission request for a token scoped to the target repository", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        form: {
          resource: "https://api.github.com/repos/fixture-target-owner/fixture-target-repository",
          scope: "actions:write",
        },
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: "ghs_test_workflow_dispatch_token",
      issued_token_type: githubInstallationAccessTokenType,
      scope: "actions:write",
      token_type: "Bearer",
    });
  });

  it("accepts reordered scope tokens for the same permission set", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        form: {
          resource: "https://api.github.com/repos/fixture-owner/fixture-source-repository",
          scope: "pull_requests:write contents:write",
        },
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: "ghs_test_token",
      scope: "contents:write pull_requests:write",
    });
  });

  it("accepts a structural GitHub App private-key binding", async () => {
    const getPrivateKey = vi.fn(async () => testEnv.GITHUB_APP_PRIVATE_KEY);
    const response = await fetchTokenExchangeWithEnv(
      "https://example.test/token",
      {
        body: await tokenExchangeRequestBody(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      },
      { ...testEnv, GITHUB_APP_PRIVATE_KEY: { get: getPrivateKey } },
    );

    expect(response.status).toBe(200);
    expect(getPrivateKey).toHaveBeenCalledTimes(2);
  });

  it("uses the shared fetch dependency and reuses OIDC caches for the Worker lifetime", async () => {
    const sharedFetch = vi.fn<typeof fetch>((input, init) => {
      const url = new Request(input).url;

      return url.startsWith("https://token.actions.githubusercontent.com/")
        ? fetchOidcRemoteDocumentResponseTestDouble(input)
        : fetchGitHubTestDouble(input, init);
    });
    const app = createTokenExchangeWorker(testTokenExchangeComposition, {
      fetch: sharedFetch,
      now: () => testNow,
    });
    const exchangeToken = async () =>
      app.fetch?.(
        new Request("https://example.test/token", {
          body: await tokenExchangeRequestBody(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
          method: "POST",
        }) as Parameters<NonNullable<typeof app.fetch>>[0],
        testEnv,
        {} as ExecutionContext,
      );

    expect((await exchangeToken())?.status).toBe(200);
    expect((await exchangeToken())?.status).toBe(200);
    expect(
      sharedFetch.mock.calls.filter(
        ([input]) =>
          new Request(input).url ===
          "https://token.actions.githubusercontent.com/.well-known/openid-configuration",
      ),
    ).toHaveLength(1);
    expect(
      sharedFetch.mock.calls.filter(
        ([input]) =>
          new Request(input).url === "https://token.actions.githubusercontent.com/.well-known/jwks",
      ),
    ).toHaveLength(1);
  });

  it("uses platform fetch and clock defaults when runtime dependencies are omitted", async () => {
    const fetchExternal = vi.fn<typeof fetch>((input, init) => {
      const request = new Request(input, init);

      return new URL(request.url).hostname === "token.actions.githubusercontent.com"
        ? fetchOidcRemoteDocumentResponseTestDouble(request)
        : fetchGitHubTestDouble(input, init);
    });
    vi.stubGlobal("fetch", fetchExternal);

    try {
      const worker = createTokenExchangeWorker(testTokenExchangeComposition);
      const response = await worker.fetch?.(
        new Request("https://example.test/token", {
          body: await tokenExchangeRequestBody(),
          headers: { "content-type": "application/x-www-form-urlencoded" },
          method: "POST",
        }) as Parameters<NonNullable<typeof worker.fetch>>[0],
        testEnv,
        {} as ExecutionContext,
      );

      expect(response?.status).toBe(200);
      expect(fetchExternal).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("captures dependencies when the Worker is constructed", async () => {
    const initialFetch = vi.fn<typeof fetch>((input, init) => {
      const url = new Request(input).url;

      return url.startsWith("https://token.actions.githubusercontent.com/")
        ? fetchOidcRemoteDocumentResponseTestDouble(input)
        : fetchGitHubTestDouble(input, init);
    });
    const replacementFetch = vi.fn<typeof fetch>();
    const oidcProviderRegistrations = [...testTokenExchangeComposition.oidcProviderRegistrations];
    const composition = {
      oidcProviderRegistrations,
      tokenIssuancePolicy: testTokenIssuancePolicy,
    };
    const runtimeDependencies = {
      ...testTokenExchangeWorkerRuntimeDependencies,
      fetch: initialFetch,
    };
    const worker = createTokenExchangeWorker(composition, runtimeDependencies);

    runtimeDependencies.fetch = replacementFetch;
    oidcProviderRegistrations.length = 0;
    composition.tokenIssuancePolicy = compileTokenIssuancePolicy([]);

    const response = await worker.fetch?.(
      new Request("https://example.test/token", {
        body: await tokenExchangeRequestBody(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }) as Parameters<NonNullable<typeof worker.fetch>>[0],
      testEnv,
      {} as ExecutionContext,
    );

    expect(response?.status).toBe(200);
    expect(initialFetch).toHaveBeenCalled();
    expect(replacementFetch).not.toHaveBeenCalled();
  });

  it("exchanges a read permission request when Token Issuance Policy permits it", async () => {
    const response = await fetchTokenExchangeWithDependencies(
      "https://example.test/token",
      {
        body: await tokenExchangeRequestBody({
          form: {
            resource: "https://api.github.com/repos/fixture-owner/fixture-source-repository",
            scope: "pull_requests:read contents:read",
          },
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      },
      {},
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: "ghs_test_read_token",
      issued_token_type: githubInstallationAccessTokenType,
      scope: "contents:read pull_requests:read",
      token_type: "Bearer",
    });
  });

  it("rejects actions-write permission requests for unconfigured target repositories", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        form: {
          resource: "https://api.github.com/repos/fixture-target-owner/fixture-unconfigured-target",
          scope: "actions:write",
        },
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_target",
    });
  });

  it("rejects arbitrary permissions not covered by policy with invalid_scope", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        form: {
          resource: "https://api.github.com/repos/fixture-owner/fixture-source-repository",
          scope: "future_permission:admin",
        },
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_scope",
    });
  });

  it("issues a token with arbitrary Requested Permissions when policy covers them", async () => {
    const requestedPermissions = { future_permission: "admin" } as const;
    const tokenIssuancePolicy = compileTokenIssuancePolicy([
      {
        permissions: requestedPermissions,
        resource: githubRepositoryResourceConstraint("fixture-owner", "fixture-source-repository"),
        subjectToken: oidcSubjectTokenConstraint(
          testSubjectConstraintMatchingVerifiedSubjectToken.issuer,
        ),
      },
    ]);
    let forwardedBody: unknown;
    const response = await fetchTokenExchangeWithDependencies(
      "https://example.test/token",
      {
        body: await tokenExchangeRequestBody({ form: { scope: "future_permission:admin" } }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      },
      {
        fetch: async (input, init) => {
          const request = new Request(input, init);

          if (new URL(request.url).hostname === "token.actions.githubusercontent.com") {
            return fetchOidcRemoteDocumentResponseTestDouble(request);
          }

          if (request.method === "POST") {
            forwardedBody = await request.json();

            return Response.json(
              {
                expires_at: "2030-01-01T00:00:00Z",
                permissions: requestedPermissions,
                token: "ghs_future_permission",
              },
              { status: 201 },
            );
          }

          return fetchGitHubTestDouble(input, init);
        },
        tokenIssuancePolicy,
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: "ghs_future_permission",
      scope: "future_permission:admin",
    });
    expect(forwardedBody).toEqual({
      permissions: requestedPermissions,
      repositories: ["fixture-source-repository"],
    });
  });

  it.each([
    { privateKey: "", scenario: "missing" },
    { privateKey: "not a private key", scenario: "invalid" },
  ])(
    "maps a $scenario GitHub App private key to a sanitized 500 server_error",
    async ({ privateKey }) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const response = await fetchTokenExchangeWithEnv(
        "https://example.test/token",
        {
          body: await tokenExchangeRequestBody(),
          headers: { "content-type": "application/x-www-form-urlencoded" },
          method: "POST",
        },
        { ...testEnv, GITHUB_APP_PRIVATE_KEY: privateKey },
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "server_error" });
      expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(
        /missing GitHub App private key|not a private key/u,
      );
    },
  );

  it("rejects the generic oauth access token type as a requested token hint", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });

  it("rejects token exchange requests without a requested token type", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({ requestedTokenType: null }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });

  it("rejects the generic JWT subject token type", async () => {
    const body = new URLSearchParams(await tokenExchangeRequestBody());
    body.set("subject_token_type", "urn:ietf:params:oauth:token-type:jwt");
    const response = await fetchTokenExchange("https://example.test/token", {
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });

  it("rejects token exchange requests with non-empty audience parameters", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        form: {
          audience: "https://github.com/apps/github-app-token-broker",
        },
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_target",
    });
  });

  it("does not accept GitHub App URLs as the OIDC audience", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        tokenOptions: {
          audience: "https://github.com/apps/github-app-token-broker",
        },
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });

  it("rejects duplicate non-empty audience parameters as unsupported targets", async () => {
    const body = new URLSearchParams(await tokenExchangeRequestBody());
    body.append("audience", "https://github.com/apps/github-app-token-broker");
    body.append("audience", "https://github.com/apps/fixture-other-app");

    const response = await fetchTokenExchange("https://example.test/token", {
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_target",
    });
  });

  it("rejects unsupported token exchange actor token parameters", async () => {
    const body = new URLSearchParams(await tokenExchangeRequestBody());
    body.set("actor_token", "actor");
    body.set("actor_token_type", "urn:ietf:params:oauth:token-type:jwt");

    const response = await fetchTokenExchange("https://example.test/token", {
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });

  it("rejects multiple non-empty resource parameters as unsupported targets", async () => {
    const body = new URLSearchParams(await tokenExchangeRequestBody());
    body.append(
      "resource",
      "https://api.github.com/repos/fixture-target-owner/fixture-target-repository",
    );

    const response = await fetchTokenExchange("https://example.test/token", {
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_target",
    });
  });

  it.each([
    ["before", ["", `https://api.github.com/repos/fixture-owner/fixture-source-repository`]],
    ["after", [`https://api.github.com/repos/fixture-owner/fixture-source-repository`, ""]],
  ])("treats an empty resource occurrence %s the target as omitted", async (_order, values) => {
    const body = new URLSearchParams(await tokenExchangeRequestBody());
    body.delete("resource");

    for (const value of values) {
      body.append("resource", value);
    }

    const response = await fetchTokenExchange("https://example.test/token", {
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: "ghs_test_token",
    });
  });

  it("rejects repeated empty resource occurrences as a missing target", async () => {
    const body = new URLSearchParams(await tokenExchangeRequestBody());
    body.delete("resource");
    body.append("resource", "");
    body.append("resource", "");

    const response = await fetchTokenExchange("https://example.test/token", {
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_target",
    });
  });

  it("rejects duplicate grant type parameters as malformed requests", async () => {
    const body = new URLSearchParams(await tokenExchangeRequestBody());
    body.append("grant_type", "urn:example:grant-type:duplicate");

    const response = await fetchTokenExchange("https://example.test/token", {
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });

  it("treats empty duplicate grant type parameters as omitted", async () => {
    const body = new URLSearchParams(await tokenExchangeRequestBody());
    body.append("grant_type", "");

    const response = await fetchTokenExchange("https://example.test/token", {
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: "ghs_test_token",
      issued_token_type: githubInstallationAccessTokenType,
      scope: "contents:write pull_requests:write",
      token_type: "Bearer",
    });
  });

  it.each([
    "authorization_details",
    "client_assertion",
    "client_assertion_type",
    "client_id",
    "client_secret",
  ])("rejects unsupported token exchange parameter %s", async (parameter) => {
    const body = new URLSearchParams(await tokenExchangeRequestBody());
    body.set(parameter, "unsupported");

    const response = await fetchTokenExchange("https://example.test/token", {
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });

  it.each([
    "actor_token",
    "actor_token_type",
    "authorization_details",
    "client_assertion",
    "client_assertion_type",
    "client_id",
    "client_secret",
  ])("treats empty unsupported token exchange parameter %s as omitted", async (parameter) => {
    const body = new URLSearchParams(await tokenExchangeRequestBody());
    body.set(parameter, "");

    const response = await fetchTokenExchange("https://example.test/token", {
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: "ghs_test_token",
      issued_token_type: githubInstallationAccessTokenType,
      scope: "contents:write pull_requests:write",
      token_type: "Bearer",
    });
  });

  it("rejects authorization header client authentication", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody(),
      headers: {
        authorization: "Basic dW5zdXBwb3J0ZWQ=",
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="github-app-token-broker"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "invalid_client",
    });
  });

  it("uses a Basic challenge when the authorization scheme is malformed", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody(),
      headers: {
        authorization: "1invalid credentials",
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="github-app-token-broker"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "invalid_client" });
  });

  it.each([
    ["omitted scope", null],
    ["empty scope", ""],
  ] as const)("rejects %s with invalid_scope", async (_caseName, scope) => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        form: {
          scope,
        },
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_scope" });
  });

  it.each([
    ["whitespace-only scope", { scope: "  " }, "invalid_scope"],
    ["padded scope", { scope: " actions:write " }, "invalid_scope"],
    ["repeated-space scope", { scope: "contents:write  pull_requests:write" }, "invalid_scope"],
    ["tab-separated scope", { scope: "contents:write\tpull_requests:write" }, "invalid_scope"],
    ["newline-separated scope", { scope: "contents:write\npull_requests:write" }, "invalid_scope"],
    ["whitespace-only resource", { resource: "  " }, "invalid_target"],
    [
      "padded resource",
      { resource: " https://api.github.com/repos/fixture-target-owner/fixture-target-repository " },
      "invalid_target",
    ],
  ])("rejects invalid token request hints: %s", async (_caseName, options, error) => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({ form: options }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error,
    });
  });

  it("rejects token exchange requests without a supported requested token type", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        requestedTokenType: "urn:example:token-type:unknown",
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });

  it("rate limits token exchange requests before parsing the request body", async () => {
    const fetchExternal = vi.fn<typeof fetch>();
    const worker = createTokenExchangeWorker(testTokenExchangeComposition, {
      ...testTokenExchangeWorkerRuntimeDependencies,
      fetch: fetchExternal,
    });
    const response = await worker.fetch?.(
      new Request("https://example.test/token", {
        body: "not a form body",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      }) as Parameters<NonNullable<typeof worker.fetch>>[0],
      {
        ...testEnv,
        TOKEN_EXCHANGE_RATE_LIMIT: {
          limit: async () => ({ success: false }),
        },
      },
      {} as ExecutionContext,
    );

    expect(response?.status).toBe(429);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    await expect(response?.json()).resolves.toEqual({
      error: "temporarily_unavailable",
    });
    expect(fetchExternal).not.toHaveBeenCalled();
  });

  it("rejects oversized token exchange request bodies", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: `grant_type=x&subject_token=${"x".repeat(64 * 1024)}`,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });

  it("maps a policy-unacceptable subject token to invalid_request", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        claims: {
          event_name: "pull_request",
          ref: "refs/pull/15/merge",
          ref_type: "branch",
          sub: "repo:fixture-owner/fixture-source-repository:pull_request",
        },
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });

  it("rejects workflow_dispatch runs from unconfigured branch refs", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        claims: {
          ref: "refs/heads/fixture-unconfigured-branch",
          sub: "repo:fixture-owner/fixture-source-repository:ref:refs/heads/fixture-unconfigured-branch",
          workflow_ref:
            "fixture-owner/fixture-source-repository/.github/workflows/fixture-token-request.yml@refs/heads/fixture-unconfigured-branch",
        },
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });

  it("rejects workflow_dispatch runs from unconfigured workflow files", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        claims: {
          workflow_ref:
            "fixture-owner/fixture-source-repository/.github/workflows/fixture-release.yml@refs/heads/fixture-base-branch",
        },
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });

  it.each([
    ["missing event name", { event_name: undefined }],
    ["non-string ref type", { ref_type: 123 }],
    ["missing repository", { repository: undefined }],
    ["null workflow ref", { workflow_ref: null }],
  ])("maps a policy claim with %s to invalid_request", async (_name, claims) => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({ claims }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });

  it("maps an empty Subject claim to invalid_request", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({ claims: { sub: "" } }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });

  it("ignores policy-irrelevant GitHub metadata", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({ claims: { actor: 123 } }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: "ghs_test_token",
      issued_token_type: githubInstallationAccessTokenType,
    });
  });

  it.each([
    [
      "repository",
      "repo:fixture-owner%2Ffixture-source-repository:ref:refs/heads/fixture-base-branch",
    ],
    ["ref", "repo:fixture-owner/fixture-source-repository:ref:refs%2Fheads%2Ffixture-base-branch"],
  ])("does not select the percent-encoded subject %s for policy", async (_component, sub) => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        claims: { sub },
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: "ghs_test_token",
      issued_token_type: githubInstallationAccessTokenType,
    });
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
    ["non-string", 123],
  ])("does not use a %s repository id for legacy subject authorization", async (_name, id) => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({ claims: { repository_id: id } }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: "ghs_test_token",
      issued_token_type: githubInstallationAccessTokenType,
    });
  });

  it("exchanges tokens whose oidc subject uses GitHub's immutable repository format", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        claims: {
          sub: "repo:fixture-owner@555555/fixture-source-repository@123456789:ref:refs/heads/fixture-base-branch",
        },
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: "ghs_test_token",
      issued_token_type: githubInstallationAccessTokenType,
      scope: "contents:write pull_requests:write",
    });
  });

  it.each([undefined, null])(
    "accepts immutable GitHub subjects when the optional owner id claim is %s",
    async (repositoryOwnerId) => {
      const response = await fetchTokenExchange("https://example.test/token", {
        body: await tokenExchangeRequestBody({
          claims: {
            repository_owner_id: repositoryOwnerId,
            sub: "repo:fixture-owner@555555/fixture-source-repository@123456789:ref:refs/heads/fixture-base-branch",
          },
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        access_token: "ghs_test_token",
        issued_token_type: githubInstallationAccessTokenType,
        scope: "contents:write pull_requests:write",
      });
    },
  );

  it.each([
    ["mismatched string", "999999"],
    ["empty string", ""],
    ["non-string", 123],
  ])("does not use a %s owner id for legacy subject authorization", async (_name, ownerId) => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        claims: {
          repository_owner_id: ownerId,
        },
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: "ghs_test_token",
      issued_token_type: githubInstallationAccessTokenType,
      scope: "contents:write pull_requests:write",
    });
  });

  it.each([
    ["missing repository id", { repository_id: undefined }],
    ["non-string repository id", { repository_id: 123 }],
    ["non-string repository owner id", { repository_owner_id: 123 }],
  ])("does not select a %s from an immutable GitHub subject", async (_name, claims) => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        claims: {
          ...claims,
          sub: "repo:fixture-owner@555555/fixture-source-repository@123456789:ref:refs/heads/fixture-base-branch",
        },
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: "ghs_test_token",
      issued_token_type: githubInstallationAccessTokenType,
    });
  });

  it.each([
    [
      "repository owner id",
      {
        repository_owner_id: "999999",
        sub: "repo:fixture-owner@555555/fixture-source-repository@123456789:ref:refs/heads/fixture-base-branch",
      },
    ],
    [
      "repository id",
      {
        repository_id: "999999999",
        sub: "repo:fixture-owner@555555/fixture-source-repository@123456789:ref:refs/heads/fixture-base-branch",
      },
    ],
  ])("does not cross-check an immutable GitHub subject against %s", async (_name, claims) => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({ claims }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: "ghs_test_token",
      issued_token_type: githubInstallationAccessTokenType,
    });
  });

  it("rejects push events on configured branch refs", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody({
        claims: {
          event_name: "push",
          ref: "refs/heads/fixture-base-branch",
        },
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });
});
