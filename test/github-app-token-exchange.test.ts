import { githubActionsOidcProviderRegistration } from "@github-app-token-broker/oidc-provider-github-actions";
import {
  createGitHubAppTokenExchange,
  maxTokenExchangeBodyBytes,
  tokenExchangeInvalidRequestResponse,
  type GitHubAppTokenExchangeConfiguration,
  type ObserveOidcDiagnostic,
  type ObserveTokenExchange,
  type TokenExchangeComposition,
  type TokenExchangeHandler,
  type TokenExchangeObservation,
  type TokenExchangeRequestContext,
  type TokenExchangeRuntimeDependencies,
} from "@github-app-token-broker/token-exchange";
import { decodeJwt } from "jose";
import { describe, expect, it, vi } from "vitest";

import {
  accessTokenType,
  oidcIdTokenType,
  testInstallationId,
  testNow,
  testRepository,
  tokenExchangeGrantType,
} from "./support/constants.ts";
import { fetchGitHubTestDouble } from "./support/github-api.ts";
import {
  fetchOidcRemoteDocumentResponseTestDouble,
  tokenExchangeRequestBody,
} from "./support/oidc.ts";
import { testPrivateKeyPem } from "./support/rsa-test-key-pair.ts";
import { testTokenIssuancePolicy } from "./support/token-issuance-policy.ts";

const configuration = {
  composition: {
    oidcProviderRegistrations: [githubActionsOidcProviderRegistration],
    tokenIssuancePolicy: testTokenIssuancePolicy,
  } satisfies TokenExchangeComposition,
  githubApp: {
    appId: "2419473",
    privateKey: testPrivateKeyPem,
  },
  subjectTokenAudience: "https://broker.example",
} satisfies GitHubAppTokenExchangeConfiguration;

describe("GitHub App Token Exchange public interface", () => {
  it("uses the platform fetch and clock when runtime dependencies are omitted", async () => {
    const externalRequests: Request[] = [];
    const platformFetch = vi.fn<typeof fetch>((input, init) => {
      const request = new Request(input, init);
      externalRequests.push(request);

      return fetchExternal(request);
    });
    vi.useFakeTimers({ now: testNow });
    vi.stubGlobal("fetch", platformFetch);

    try {
      const tokenExchange = createGitHubAppTokenExchange(configuration);
      const response = await tokenExchange(await tokenRequest(), requestContext());
      const nowSeconds = Math.floor(testNow.getTime() / 1000);
      const githubAppJwtClaims = externalRequests
        .filter((request) => new URL(request.url).hostname === "api.github.com")
        .map((request) => {
          const authorization = request.headers.get("authorization");

          if (authorization === null) {
            throw new Error("expected GitHub request authentication");
          }

          return decodeJwt(authorization.slice("Bearer ".length));
        });

      expect(response.status).toBe(200);
      expect(externalRequests.map(({ url }) => url)).toEqual([
        "https://token.actions.githubusercontent.com/.well-known/openid-configuration",
        "https://token.actions.githubusercontent.com/.well-known/jwks",
        "https://api.github.com/repos/fixture-owner/fixture-source-repository/installation",
        "https://api.github.com/app/installations/67890/access_tokens",
      ]);
      expect(githubAppJwtClaims).toHaveLength(2);
      expect(githubAppJwtClaims.map(({ exp, iat }) => ({ exp, iat }))).toEqual([
        { exp: nowSeconds + 9 * 60, iat: nowSeconds - 60 },
        { exp: nowSeconds + 9 * 60, iat: nowSeconds - 60 },
      ]);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("keeps the GitHub destination fixed and preserves transport constraints", async () => {
    const githubRequests: Array<{ init: RequestInit | undefined; url: string }> = [];
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchExternal = vi.fn<typeof fetch>((input, init) => {
      const request = new Request(input, init);

      if (new URL(request.url).hostname === "token.actions.githubusercontent.com") {
        return fetchOidcRemoteDocumentResponseTestDouble(request);
      }

      githubRequests.push({ init, url: request.url });
      return fetchGitHubTestDouble(request);
    });
    const configurationWithIgnoredDestination = {
      ...configuration,
      githubApp: {
        ...configuration.githubApp,
        apiBaseUrl: "https://attacker.invalid",
      },
    } as GitHubAppTokenExchangeConfiguration;
    const tokenExchange = createGitHubAppTokenExchange(configurationWithIgnoredDestination, {
      fetch: fetchExternal,
      now: () => testNow,
    });

    try {
      const response = await tokenExchange(await tokenRequest(), requestContext());

      expect(response.status).toBe(200);
      expect(githubRequests.map(({ url }) => url)).toEqual([
        "https://api.github.com/repos/fixture-owner/fixture-source-repository/installation",
        "https://api.github.com/app/installations/67890/access_tokens",
      ]);
      expect(githubRequests.every(({ init }) => init?.redirect === "manual")).toBe(true);
      expect(githubRequests.every(({ init }) => init?.signal instanceof AbortSignal)).toBe(true);
      expect(timeout).toHaveBeenCalledWith(10_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it("snapshots configuration when the public handler is constructed", async () => {
    const observedIssuers: unknown[] = [];
    const mutableConfiguration = {
      composition: {
        oidcProviderRegistrations: [githubActionsOidcProviderRegistration],
        tokenIssuancePolicy: testTokenIssuancePolicy,
      },
      githubApp: {
        appId: "2419473",
        privateKey: testPrivateKeyPem,
      },
      subjectTokenAudience: "https://broker.example",
    };
    const tokenExchange = createGitHubAppTokenExchange(mutableConfiguration, {
      fetch: async (input, init) => {
        const request = new Request(input, init);

        if (new URL(request.url).hostname === "api.github.com") {
          const authorization = request.headers.get("authorization");
          observedIssuers.push(
            authorization === null
              ? undefined
              : (await import("jose")).decodeJwt(authorization.slice("Bearer ".length)).iss,
          );
        }

        return fetchExternal(request);
      },
      now: () => testNow,
    });

    mutableConfiguration.composition.oidcProviderRegistrations.length = 0;
    mutableConfiguration.githubApp.appId = "mutated";
    mutableConfiguration.githubApp.privateKey = "mutated";
    mutableConfiguration.subjectTokenAudience = "mutated";

    const response = await tokenExchange(await tokenRequest(), requestContext());

    expect(response.status).toBe(200);
    expect(observedIssuers).toEqual(["2419473", "2419473"]);
  });

  it("enforces the GitHub deadline through the public handler", async () => {
    let githubDeadline: AbortController | undefined;
    const timeoutDurations: number[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      timeoutDurations.push(milliseconds);
      const deadline = new AbortController();
      githubDeadline = deadline;

      return deadline.signal;
    });
    const fetchExternal = vi.fn<typeof fetch>((input, init) => {
      const request = new Request(input, init);

      if (new URL(request.url).hostname === "token.actions.githubusercontent.com") {
        return fetchOidcRemoteDocumentResponseTestDouble(request);
      }

      queueMicrotask(() =>
        githubDeadline?.abort(new DOMException("private timeout", "TimeoutError")),
      );
      return new Promise<Response>(() => undefined);
    });
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: fetchExternal,
      now: () => testNow,
    });

    try {
      const response = await tokenExchange(await tokenRequest(), requestContext());

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "temporarily_unavailable" });
      expect(timeoutDurations).toContain(10_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it("keeps optional OIDC diagnostics separate from mandatory observations", async () => {
    const observations: TokenExchangeObservation[] = [];
    const observeOidcDiagnostic = vi.fn(() => {
      throw new Error("optional diagnostic failure");
    });
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: fetchExternal,
      now: () => testNow,
    });
    const response = await tokenExchange(await tokenRequest(), {
      observe: async (observation) => {
        observations.push(observation);
      },
      observeOidcDiagnostic,
    });

    expect(response.status).toBe(200);
    expect(observeOidcDiagnostic).toHaveBeenCalled();
    expect(observations.map(({ fields }) => fields["event"])).toEqual([
      "installation_access_token_issuance_started",
      "installation_access_token_issuance_succeeded",
    ]);
  });

  it("records permissions granted by GitHub through the public observation interface", async () => {
    const observations: TokenExchangeObservation[] = [];
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: async (input, init) => {
        const request = new Request(input, init);

        if (
          request.method === "POST" &&
          new URL(request.url).pathname === "/app/installations/67890/access_tokens"
        ) {
          return Response.json(
            {
              expires_at: "2030-01-01T00:00:00Z",
              permissions: { contents: "write", metadata: "read", pull_requests: "write" },
              token: "ghs_test_token",
            },
            { status: 201 },
          );
        }

        return fetchExternal(request);
      },
      now: () => testNow,
    });
    const response = await tokenExchange(await tokenRequest(), {
      observe: async (observation) => {
        observations.push(observation);
      },
    });

    expect(response.status).toBe(200);
    expect(observations).toContainEqual(
      expect.objectContaining({
        fields: expect.objectContaining({
          installation_access_token: {
            permissions: { contents: "write", metadata: "read", pull_requests: "write" },
          },
        }),
      }),
    );
  });

  it("retains the resolved installation in an observed mint failure", async () => {
    const observations: TokenExchangeObservation[] = [];
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: async (input, init) => {
        const request = new Request(input, init);

        if (
          request.method === "POST" &&
          new URL(request.url).pathname === "/app/installations/67890/access_tokens"
        ) {
          return new Response(null, { status: 500 });
        }

        return fetchExternal(request);
      },
      now: () => testNow,
    });
    const response = await tokenExchange(await tokenRequest(), {
      observe: async (observation) => {
        observations.push(observation);
      },
    });

    expect(response.status).toBe(502);
    expect(observations).toContainEqual(
      expect.objectContaining({
        fields: expect.objectContaining({
          event: "installation_access_token_issuance_failed",
          target_installation: { id: 67890 },
        }),
      }),
    );
  });

  it.each([
    { error: "server_error", headers: undefined, responseStatus: 500, upstreamStatus: 400 },
    { error: "server_error", headers: undefined, responseStatus: 500, upstreamStatus: 401 },
    { error: "server_error", headers: undefined, responseStatus: 500, upstreamStatus: 422 },
    { error: "server_error", headers: undefined, responseStatus: 502, upstreamStatus: 403 },
    { error: "server_error", headers: undefined, responseStatus: 502, upstreamStatus: 404 },
    { error: "server_error", headers: undefined, responseStatus: 502, upstreamStatus: 500 },
    {
      error: "temporarily_unavailable",
      headers: undefined,
      responseStatus: 503,
      upstreamStatus: 429,
    },
    {
      error: "temporarily_unavailable",
      headers: undefined,
      responseStatus: 503,
      upstreamStatus: 503,
    },
    {
      error: "temporarily_unavailable",
      headers: { "x-ratelimit-remaining": "0" },
      responseStatus: 503,
      upstreamStatus: 403,
    },
  ] as const)(
    "maps GitHub installation-resolution status $upstreamStatus to OAuth status $responseStatus",
    async ({ error, headers, responseStatus, upstreamStatus }) => {
      const tokenExchange = createGitHubAppTokenExchange(configuration, {
        fetch: async (input, init) => {
          const request = new Request(input, init);

          return new URL(request.url).hostname === "token.actions.githubusercontent.com"
            ? fetchOidcRemoteDocumentResponseTestDouble(request)
            : new Response(null, {
                ...(headers === undefined ? {} : { headers }),
                status: upstreamStatus,
              });
        },
        now: () => testNow,
      });
      const response = await tokenExchange(await tokenRequest(), requestContext());

      expect(response.status).toBe(responseStatus);
      await expect(response.json()).resolves.toEqual({ error });
    },
  );

  it("sanitizes a GitHub transport failure through the public handler", async () => {
    const failureDetail = "private GitHub transport failure";
    const observations: TokenExchangeObservation[] = [];
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: async (input, init) => {
        const request = new Request(input, init);

        if (new URL(request.url).hostname === "token.actions.githubusercontent.com") {
          return fetchOidcRemoteDocumentResponseTestDouble(request);
        }

        throw new Error(failureDetail);
      },
      now: () => testNow,
    });
    const response = await tokenExchange(await tokenRequest(), {
      observe: async (observation) => {
        observations.push(observation);
      },
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    await expect(response.json()).resolves.toEqual({ error: "temporarily_unavailable" });
    expect(JSON.stringify(observations)).not.toContain(failureDetail);
  });

  it("maps OIDC provider unavailability without attempting GitHub I/O", async () => {
    const githubRequests: Request[] = [];
    const observations: TokenExchangeObservation[] = [];
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: async (input, init) => {
        const request = new Request(input, init);

        if (new URL(request.url).hostname === "token.actions.githubusercontent.com") {
          return new Response(null, { status: 503 });
        }

        githubRequests.push(request);
        return fetchGitHubTestDouble(request);
      },
      now: () => testNow,
    });
    const response = await tokenExchange(await tokenRequest(), {
      observe: async (observation) => {
        observations.push(observation);
      },
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    await expect(response.json()).resolves.toEqual({ error: "temporarily_unavailable" });
    expect(githubRequests).toEqual([]);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      fields: { path: "/token", reason: "oidc_provider_failure" },
      level: "warn",
      message: "OIDC authentication failed",
    });
    expect(observations[0]?.fields).not.toHaveProperty("rayId");
  });

  it("sanitizes a real OIDC internal failure with runtime-neutral request context", async () => {
    const failureDetail = "private OIDC clock failure with credential detail";
    const fetchExternal = vi.fn<typeof fetch>();
    const observations: TokenExchangeObservation[] = [];
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: fetchExternal,
      now: () => {
        throw new Error(failureDetail);
      },
    });
    const body = await tokenExchangeRequestBody();
    const subjectToken = new URLSearchParams(body).get("subject_token");
    if (subjectToken === null) {
      throw new Error("test Token Exchange request did not contain a subject token");
    }
    const response = await tokenExchange(
      new Request("https://broker.example/token", {
        body,
        headers: {
          "cf-ray": "must-not-enter-neutral-observation",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "fixture-test-agent",
        },
        method: "POST",
      }),
      {
        observe: async (observation) => {
          observations.push(observation);
        },
      },
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("www-authenticate")).toBeNull();
    await expect(response.json()).resolves.toEqual({ error: "server_error" });
    expect(fetchExternal).not.toHaveBeenCalled();
    expect(observations).toEqual([
      {
        fields: {
          path: "/token",
          reason: "oidc_internal_failure",
          userAgent: "fixture-test-agent",
        },
        level: "warn",
        message: "OIDC authentication failed",
      },
    ]);
    const serializedObservations = JSON.stringify(observations);
    expect(serializedObservations).not.toContain("cf-ray");
    expect(serializedObservations).not.toContain("must-not-enter-neutral-observation");
    expect(serializedObservations).not.toContain(failureDetail);
    expect(serializedObservations).not.toContain(subjectToken);
    expect(serializedObservations).not.toContain(configuration.githubApp.privateKey);
    expect(serializedObservations).not.toContain("ghs_test_token");
  });

  it.each([
    {
      appId: "not-an-app-id",
      expectedError: {
        message: "invalid GitHub App configuration",
        name: "GitHubAppConfigurationError",
      },
      privateDetails: ["not-an-app-id"],
      privateKey: configuration.githubApp.privateKey,
      scenario: "an invalid App ID",
    },
    {
      appId: configuration.githubApp.appId,
      expectedError: {
        message: "invalid GitHub App configuration",
        name: "GitHubAppConfigurationError",
      },
      privateDetails: [],
      privateKey: "",
      scenario: "an empty private key",
    },
    {
      appId: configuration.githubApp.appId,
      expectedError: {
        message: "invalid GitHub App configuration",
        name: "GitHubAppConfigurationError",
      },
      privateDetails: ["not a private key"],
      privateKey: "not a private key",
      scenario: "an invalid private key",
    },
    {
      appId: configuration.githubApp.appId,
      expectedError: {
        message: "unexpected Installation Access Token Issuance error",
        name: "Error",
      },
      privateDetails: ["private secret binding rejection", "PrivateSecretBindingError"],
      privateKey: {
        get: async () => {
          const error = new Error("private secret binding rejection");
          error.name = "PrivateSecretBindingError";
          throw error;
        },
      },
      scenario: "a rejected structural secret binding",
    },
  ] as const)(
    "sanitizes $scenario before GitHub I/O",
    async ({ appId, expectedError, privateDetails, privateKey }) => {
      const githubRequests: Request[] = [];
      const observations: TokenExchangeObservation[] = [];
      const tokenExchange = createGitHubAppTokenExchange(
        {
          ...configuration,
          githubApp: { appId, privateKey },
        },
        {
          fetch: async (input, init) => {
            const request = new Request(input, init);

            if (new URL(request.url).hostname === "token.actions.githubusercontent.com") {
              return fetchOidcRemoteDocumentResponseTestDouble(request);
            }

            githubRequests.push(request);
            return fetchGitHubTestDouble(request);
          },
          now: () => testNow,
        },
      );
      const body = await tokenExchangeRequestBody();
      const subjectToken = new URLSearchParams(body).get("subject_token");
      if (subjectToken === null) {
        throw new Error("test Token Exchange request did not contain a subject token");
      }
      const response = await tokenExchange(
        new Request("https://broker.example/token", {
          body,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          method: "POST",
        }),
        {
          observe: async (observation) => {
            observations.push(observation);
          },
        },
      );

      expect(response.status).toBe(500);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      expect(response.headers.get("www-authenticate")).toBeNull();
      const responseBody = await response.json();
      expect(responseBody).toEqual({ error: "server_error" });
      expect(githubRequests).toEqual([]);
      expect(observations.map(({ fields }) => fields["event"])).toEqual([
        "installation_access_token_issuance_started",
        "installation_access_token_issuance_failed",
      ]);
      expect(observations[1]).toMatchObject({ fields: { error: expectedError } });
      const serializedBoundary = JSON.stringify({ observations, responseBody });
      for (const privateDetail of privateDetails) {
        expect(serializedBoundary).not.toContain(privateDetail);
      }
      expect(serializedBoundary).not.toContain(subjectToken);
      expect(serializedBoundary).not.toContain("ghs_test_token");
    },
  );

  it("sanitizes a failing request body stream", async () => {
    const failureDetail = "subject_token=private-stream-detail";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(failureDetail));
      },
    });
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: vi.fn<typeof fetch>(),
      now: () => testNow,
    });

    try {
      const response = await tokenExchange(
        new Request("https://broker.example/token", {
          body,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          method: "POST",
        }),
        requestContext(),
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "server_error" });
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(failureDetail);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("fails closed before GitHub I/O when mandatory observation is not acknowledged", async () => {
    const githubRequests: Request[] = [];
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: async (input, init) => {
        const request = new Request(input, init);

        if (new URL(request.url).hostname === "token.actions.githubusercontent.com") {
          return fetchOidcRemoteDocumentResponseTestDouble(request);
        }

        githubRequests.push(request);
        return fetchGitHubTestDouble(request);
      },
      now: () => testNow,
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await tokenExchange(await tokenRequest(), {
        observe: async (observation) => {
          if (observation.fields["event"] === "installation_access_token_issuance_started") {
            throw new Error("private observation failure");
          }
        },
      });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "server_error" });
      expect(githubRequests).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("awaits successful revocation before failing closed on a post-mint observation failure", async () => {
    const observerFailure = "private post-mint observer failure";
    const githubRequests: Request[] = [];
    const observedEvents: unknown[] = [];
    let completeRevocation: (response: Response) => void = () => undefined;
    let markRevocationStarted: () => void = () => undefined;
    const revocation = new Promise<Response>((resolve) => {
      completeRevocation = resolve;
    });
    const revocationStarted = new Promise<void>((resolve) => {
      markRevocationStarted = resolve;
    });
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: (input, init) => {
        const request = new Request(input, init);

        if (new URL(request.url).hostname === "token.actions.githubusercontent.com") {
          return fetchOidcRemoteDocumentResponseTestDouble(request);
        }

        githubRequests.push(request);

        if (
          request.method === "DELETE" &&
          new URL(request.url).pathname === "/installation/token"
        ) {
          markRevocationStarted();

          return revocation;
        }

        return fetchGitHubTestDouble(request);
      },
      now: () => testNow,
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      let responseSettled = false;
      const responsePromise = tokenExchange(await tokenRequest(), {
        observe: async (observation) => {
          const event = observation.fields["event"];
          observedEvents.push(event);

          if (event === "installation_access_token_issuance_succeeded") {
            throw new Error(observerFailure);
          }
        },
      }).then((response) => {
        responseSettled = true;

        return response;
      });

      await revocationStarted;
      await Promise.resolve();
      expect(responseSettled).toBe(false);
      completeRevocation(new Response(null, { status: 204 }));
      const response = await responsePromise;
      const responseBody = await response.json();

      expect(response.status).toBe(500);
      expect(responseBody).toEqual({ error: "server_error" });
      expect(JSON.stringify(responseBody)).not.toContain("ghs_test_token");
      expect(observedEvents).toEqual([
        "installation_access_token_issuance_started",
        "installation_access_token_issuance_succeeded",
      ]);
      expect(
        githubRequests.map((request) => ({
          method: request.method,
          path: new URL(request.url).pathname,
        })),
      ).toEqual([
        { method: "GET", path: `/repos/${testRepository}/installation` },
        { method: "POST", path: `/app/installations/${testInstallationId}/access_tokens` },
        { method: "DELETE", path: "/installation/token" },
      ]);
      expect(githubRequests[2]?.headers.get("authorization")).toBe("Bearer ghs_test_token");
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(observerFailure);
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("ghs_test_token");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not return or re-observe a token when GitHub rejects revocation", async () => {
    const observerFailure = "private post-mint observer failure";
    const githubRequests: Request[] = [];
    const observedEvents: unknown[] = [];
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: (input, init) => {
        const request = new Request(input, init);

        if (new URL(request.url).hostname === "token.actions.githubusercontent.com") {
          return fetchOidcRemoteDocumentResponseTestDouble(request);
        }

        githubRequests.push(request);

        return request.method === "DELETE" &&
          new URL(request.url).pathname === "/installation/token"
          ? Promise.resolve(new Response("private revocation response", { status: 503 }))
          : fetchGitHubTestDouble(request);
      },
      now: () => testNow,
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await tokenExchange(await tokenRequest(), {
        observe: async (observation) => {
          const event = observation.fields["event"];
          observedEvents.push(event);

          if (event === "installation_access_token_issuance_succeeded") {
            throw new Error(observerFailure);
          }
        },
      });
      const responseBody = await response.json();

      expect(response.status).toBe(500);
      expect(responseBody).toEqual({ error: "server_error" });
      expect(JSON.stringify(responseBody)).not.toContain("ghs_test_token");
      expect(observedEvents).toEqual([
        "installation_access_token_issuance_started",
        "installation_access_token_issuance_succeeded",
      ]);
      const revocationRequests = githubRequests.filter(
        (request) =>
          request.method === "DELETE" && new URL(request.url).pathname === "/installation/token",
      );
      expect(revocationRequests).toHaveLength(1);
      expect(revocationRequests[0]?.headers.get("authorization")).toBe("Bearer ghs_test_token");
      const serializedLog = JSON.stringify(consoleError.mock.calls);
      expect(serializedLog).not.toContain(observerFailure);
      expect(serializedLog).not.toContain("private revocation response");
      expect(serializedLog).not.toContain("ghs_test_token");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("fails closed when an authentication-failure observation is not acknowledged", async () => {
    const fetchExternal = vi.fn<typeof fetch>();
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: fetchExternal,
      now: () => testNow,
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await tokenExchange(formRequest(), {
        observe: async () => {
          throw new Error("private authentication observation failure");
        },
      });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "server_error" });
      expect(fetchExternal).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each([
    {
      error: "invalid_scope",
      options: { form: { scope: "issues:read" } },
      outcome: "requested_permissions_unsupported",
    },
    {
      error: "invalid_request",
      options: { claims: { event_name: "push" } },
      outcome: "subject_token_unacceptable",
    },
    {
      error: "invalid_target",
      options: {
        form: {
          resource: "https://api.github.com/repos/fixture-target-owner/fixture-unconfigured-target",
        },
      },
      outcome: "target_unsupported",
    },
  ] as const)(
    "maps policy outcome $outcome through the public handler",
    async ({ error, options }) => {
      const githubRequests: Request[] = [];
      const tokenExchange = createGitHubAppTokenExchange(configuration, {
        fetch: async (input, init) => {
          const request = new Request(input, init);

          if (new URL(request.url).hostname === "token.actions.githubusercontent.com") {
            return fetchOidcRemoteDocumentResponseTestDouble(request);
          }

          githubRequests.push(request);
          return fetchGitHubTestDouble(request);
        },
        now: () => testNow,
      });
      const response = await tokenExchange(
        new Request("https://broker.example/token", {
          body: await tokenExchangeRequestBody(options),
          headers: { "content-type": "application/x-www-form-urlencoded" },
          method: "POST",
        }),
        requestContext(),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error });
      expect(githubRequests).toEqual([]);
    },
  );

  it("validates method and media type without external I/O", async () => {
    const fetchExternal = vi.fn<typeof fetch>();
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: fetchExternal,
      now: () => testNow,
    });

    const methodResponse = await tokenExchange(
      new Request("https://broker.example/token", {
        body: await tokenExchangeRequestBody(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "PUT",
      }),
      requestContext(),
    );
    const mediaTypeResponse = await tokenExchange(
      new Request("https://broker.example/token", { body: "ignored", method: "POST" }),
      requestContext(),
    );

    expect(methodResponse.status).toBe(400);
    await expect(methodResponse.json()).resolves.toEqual({ error: "invalid_request" });
    expect(mediaTypeResponse.status).toBe(400);
    await expect(mediaTypeResponse.json()).resolves.toEqual({ error: "invalid_request" });
    expect(fetchExternal).not.toHaveBeenCalled();
  });

  it.each([
    ["Basic dW5zdXBwb3J0ZWQ=", 'Basic realm="github-app-token-broker"'],
    ["Bearer subject-token", 'Bearer realm="github-app-token-broker"'],
    ["1invalid credentials", 'Basic realm="github-app-token-broker"'],
  ])("rejects client authentication using the %s challenge", async (authorization, challenge) => {
    const fetchExternal = vi.fn<typeof fetch>();
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: fetchExternal,
      now: () => testNow,
    });
    const request = formRequest();
    request.headers.set("authorization", authorization);
    const response = await tokenExchange(request, requestContext());

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(challenge);
    await expect(response.json()).resolves.toEqual({ error: "invalid_client" });
    expect(fetchExternal).not.toHaveBeenCalled();
  });

  it.each([
    [
      "urn:chikachow:github-app-installation-access-token",
      "urn:chikachow:github-app-installation-access-token",
    ],
    [
      "urn:ietf:params:oauth:token-type:access_token",
      "urn:ietf:params:oauth:token-type:access_token",
    ],
  ])("echoes the supported requested token type %s", async (requestedTokenType, expectedType) => {
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: fetchExternal,
      now: () => testNow,
    });
    const response = await tokenExchange(
      await tokenRequest({ requested_token_type: requestedTokenType }),
      requestContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ issued_token_type: expectedType });
  });

  it("canonicalizes reordered permission scope in the response", async () => {
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: fetchExternal,
      now: () => testNow,
    });
    const response = await tokenExchange(
      await tokenRequest({ scope: "pull_requests:write contents:write" }),
      requestContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      scope: "contents:write pull_requests:write",
    });
  });

  it.each([
    ["missing grant type", { grant_type: null }, "invalid_request"],
    ["unsupported grant type", { grant_type: "urn:example:unsupported" }, "unsupported_grant_type"],
    ["missing subject token", { subject_token: null }, "invalid_request"],
    ["empty subject token", { subject_token: "" }, "invalid_request"],
    [
      "generic JWT subject-token type",
      { subject_token_type: "urn:ietf:params:oauth:token-type:jwt" },
      "invalid_request",
    ],
    ["missing requested token type", { requested_token_type: null }, "invalid_request"],
    [
      "unsupported requested token type",
      { requested_token_type: "urn:example:unknown" },
      "invalid_request",
    ],
    ["non-empty audience", { audience: "https://broker.example" }, "invalid_target"],
    ["missing scope", { scope: null }, "invalid_scope"],
    ["empty scope", { scope: "" }, "invalid_scope"],
    ["padded scope", { scope: " contents:write" }, "invalid_scope"],
    [
      "malformed resource",
      { resource: "https://github.com/fixture-owner/fixture-source-repository" },
      "invalid_target",
    ],
  ] as const)("rejects %s through the public handler", async (_scenario, overrides, error) => {
    const fetchExternal = vi.fn<typeof fetch>();
    const observe = vi.fn(async () => undefined);
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: fetchExternal,
      now: () => testNow,
    });
    const response = await tokenExchange(formRequest(overrides), { observe });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error });
    expect(observe).not.toHaveBeenCalled();
    expect(fetchExternal).not.toHaveBeenCalled();
  });

  it.each([
    "actor_token",
    "actor_token_type",
    "authorization_details",
    "client_assertion",
    "client_assertion_type",
    "client_id",
    "client_secret",
  ] as const)("rejects a non-empty unsupported %s", async (field) => {
    const fetchExternal = vi.fn<typeof fetch>();
    const observe = vi.fn(async () => undefined);
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: fetchExternal,
      now: () => testNow,
    });
    const response = await tokenExchange(formRequest({ [field]: "unsupported" }), { observe });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(observe).not.toHaveBeenCalled();
    expect(fetchExternal).not.toHaveBeenCalled();
  });

  it("ignores empty unsupported parameters before authenticating the Subject Token", async () => {
    const observe = vi.fn(async () => undefined);
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: vi.fn<typeof fetch>(),
      now: () => testNow,
    });
    const form = validForm();

    for (const field of [
      "actor_token",
      "actor_token_type",
      "authorization_details",
      "client_assertion",
      "client_assertion_type",
      "client_id",
      "client_secret",
    ]) {
      form.append(field, "");
    }

    const response = await tokenExchange(formRequest({}, form), { observe });

    expect(response.status).toBe(400);
    expect(observe).toHaveBeenCalledWith({
      fields: {
        diagnosticCode: "ERR_JWT_INVALID",
        path: "/token",
        reason: "invalid_token",
        userAgent: null,
      },
      level: "warn",
      message: "OIDC authentication failed",
    });
  });

  it("rejects duplicate non-empty singleton values and accepts surrounding empty values", async () => {
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: vi.fn<typeof fetch>(),
      now: () => testNow,
    });
    const rejectedForm = validForm();
    rejectedForm.append("scope", "contents:read");
    const rejectedObserve = vi.fn(async () => undefined);
    const rejected = await tokenExchange(formRequest({}, rejectedForm), {
      observe: rejectedObserve,
    });
    const acceptedForm = validForm();
    acceptedForm.append("scope", "");
    acceptedForm.append("resource", "");
    const acceptedObserve = vi.fn(async () => undefined);
    const accepted = await tokenExchange(formRequest({}, acceptedForm), {
      observe: acceptedObserve,
    });

    expect(rejected.status).toBe(400);
    expect(rejectedObserve).not.toHaveBeenCalled();
    expect(accepted.status).toBe(400);
    expect(acceptedObserve).toHaveBeenCalled();
  });

  it("accepts an empty singleton occurrence before its non-empty value", async () => {
    const observations: TokenExchangeObservation[] = [];
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: fetchExternal,
      now: () => testNow,
    });
    const validBody = new URLSearchParams(await tokenExchangeRequestBody());
    const form = new URLSearchParams([["grant_type", ""], ...validBody]);
    const response = await tokenExchange(
      new Request("https://broker.example/token", {
        body: form,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      {
        observe: async (observation) => {
          observations.push(observation);
        },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ access_token: "ghs_test_token" });
    expect(observations.map(({ fields }) => fields["event"])).toEqual([
      "installation_access_token_issuance_started",
      "installation_access_token_issuance_succeeded",
    ]);
  });

  it("rejects an oversized body before authentication", async () => {
    const observe = vi.fn(async () => undefined);
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: vi.fn<typeof fetch>(),
      now: () => testNow,
    });
    const response = await tokenExchange(
      new Request("https://broker.example/token", {
        body: `grant_type=x&subject_token=${"x".repeat(64 * 1024)}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      { observe },
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(observe).not.toHaveBeenCalled();
  });

  it("does not expose a configurable GitHub API destination", () => {
    const invalidConfiguration: GitHubAppTokenExchangeConfiguration = {
      ...configuration,
      githubApp: {
        ...configuration.githubApp,
        // @ts-expect-error The GitHub API destination is fixed by the GitHub module.
        apiBaseUrl: "https://attacker.invalid",
      },
    };

    expect(invalidConfiguration.githubApp.appId).toBe(configuration.githubApp.appId);
  });

  it("exposes only the HTTP adapter facts needed to enforce the request-body contract", async () => {
    expect(maxTokenExchangeBodyBytes).toBe(64 * 1024);

    const response = tokenExchangeInvalidRequestResponse(413);

    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
  });
});

function requestContext(): TokenExchangeRequestContext {
  const observe: ObserveTokenExchange = async () => undefined;
  const observeOidcDiagnostic: ObserveOidcDiagnostic = () => undefined;

  return { observe, observeOidcDiagnostic };
}

async function tokenRequest(form: Record<string, string> = {}): Promise<Request> {
  return new Request("https://broker.example/token", {
    body: await tokenExchangeRequestBody({ form }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
}

function fetchExternal(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);

  return new URL(request.url).hostname === "token.actions.githubusercontent.com"
    ? fetchOidcRemoteDocumentResponseTestDouble(request)
    : fetchGitHubTestDouble(request);
}

const runtimeDependencies = {
  fetch: fetchExternal,
  now: () => testNow,
} satisfies TokenExchangeRuntimeDependencies;
const publicHandler: TokenExchangeHandler = createGitHubAppTokenExchange(
  configuration,
  runtimeDependencies,
);
void publicHandler;

function validForm(overrides: Record<string, string | null> = {}): URLSearchParams {
  const form = new URLSearchParams({
    grant_type: tokenExchangeGrantType,
    requested_token_type: accessTokenType,
    resource: "https://api.github.com/repos/fixture-owner/fixture-source-repository",
    scope: "contents:write pull_requests:write",
    subject_token: "not-a-jwt",
    subject_token_type: oidcIdTokenType,
  });

  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) {
      form.delete(key);
    } else {
      form.set(key, value);
    }
  }

  return form;
}

function formRequest(
  overrides: Record<string, string | null> = {},
  form: URLSearchParams = validForm(overrides),
): Request {
  return new Request("https://broker.example/token", {
    body: form,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
}
