import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTokenExchangeWorker,
  type TokenExchangeWorkerEnv,
} from "@github-app-token-broker/worker";
import { compileTokenIssuancePolicy } from "@github-app-token-broker/token-issuance-policy";
import { decodeJwt } from "jose";

import { testNow } from "./support/constants.ts";
import { fetchGitHubTestDouble } from "./support/github-api.ts";
import { fetchOidcRemoteDocumentResponseTestDouble } from "./support/oidc.ts";
import { testTokenIssuancePolicy } from "./support/token-issuance-policy.ts";
import {
  authorizationHeaders,
  fetchTokenExchange,
  fetchTokenExchangeWithEnv,
  testEnv,
  testTokenExchangeComposition,
  testTokenExchangeWorkerRuntimeDependencies,
  tokenExchangeRequestBody,
} from "./support/worker.ts";
describe("Token Exchange Worker boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: testNow });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["/github/claims", "/github/installations/token"])(
    "does not expose the removed %s endpoint",
    async (pathname) => {
      const response = await fetchTokenExchange(`https://example.test${pathname}`, {
        headers: await authorizationHeaders(),
        method: "POST",
      });

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
      await expect(response.json()).resolves.toEqual({
        status: 404,
        title: "Not Found",
        type: "about:blank",
      });
    },
  );

  it("rejects non-POST requests at the Token Endpoint boundary", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "PUT",
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
  });

  it.each([
    {
      expectedKey: "203.0.113.10",
      headers: { "cf-connecting-ip": "203.0.113.10", "x-forwarded-for": "198.51.100.20" },
      scenario: "prefers CF-Connecting-IP to X-Forwarded-For",
    },
    {
      expectedKey: "unknown",
      headers: { "x-forwarded-for": "198.51.100.20" },
      scenario: "ignores X-Forwarded-For",
    },
    {
      expectedKey: "unknown",
      headers: {},
      scenario: "uses the unknown fallback without an address header",
    },
  ])("$scenario for admission and returns a 429 denial", async ({ expectedKey, headers }) => {
    const limit = vi.fn(async () => ({ success: false }));
    const fetchExternal = vi.fn<typeof fetch>();
    const worker = createTokenExchangeWorker(testTokenExchangeComposition, {
      ...testTokenExchangeWorkerRuntimeDependencies,
      fetch: fetchExternal,
    });
    const response = await invokeWorker(worker, await tokenRequest(headers), {
      ...testEnv,
      TOKEN_EXCHANGE_RATE_LIMIT: { limit },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    await expect(response.json()).resolves.toEqual({ error: "temporarily_unavailable" });
    expect(limit).toHaveBeenCalledExactlyOnceWith({ key: expectedKey });
    expect(fetchExternal).not.toHaveBeenCalled();
  });

  it("denies admission before authentication, body parsing, observations, or external I/O", async () => {
    let bodyPulled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          bodyPulled = true;
          controller.error(new Error("private body failure"));
        },
      },
      { highWaterMark: 0 },
    );
    const limit = vi.fn(async () => ({ success: false }));
    const fetchExternal = vi.fn<typeof fetch>();
    const observe = vi.fn(async () => undefined);
    const worker = createTokenExchangeWorker(testTokenExchangeComposition, {
      fetch: fetchExternal,
      now: () => testNow,
      observe,
    });
    const response = await invokeWorker(
      worker,
      new Request("https://example.test/token", {
        body,
        headers: {
          authorization: "Basic private-client-credentials",
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      }),
      { ...testEnv, TOKEN_EXCHANGE_RATE_LIMIT: { limit } },
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: "temporarily_unavailable" });
    expect(limit).toHaveBeenCalledExactlyOnceWith({ key: "unknown" });
    expect(bodyPulled).toBe(false);
    expect(observe).not.toHaveBeenCalled();
    expect(fetchExternal).not.toHaveBeenCalled();
  });

  it("wires a representative valid request through OIDC authentication, policy, and GitHub issuance", async () => {
    const response = await fetchTokenExchange("https://example.test/token", {
      body: await tokenExchangeRequestBody(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    await expect(response.json()).resolves.toEqual({
      access_token: "ghs_test_token",
      expires_in: 113875200,
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: "contents:write pull_requests:write",
      token_type: "Bearer",
    });
  });

  it("keeps optional OIDC diagnostics separate from mandatory Token Exchange observations", async () => {
    const observeOidcDiagnostic = vi.fn(() => {
      throw new Error("optional OIDC diagnostic failure");
    });
    const worker = createTokenExchangeWorker(testTokenExchangeComposition, {
      fetch: testTokenExchangeWorkerRuntimeDependencies.fetch,
      now: () => testNow,
      observe: async () => undefined,
      observeOidcDiagnostic,
    });
    const response = await invokeWorker(worker, await tokenRequest());

    expect(response.status).toBe(200);
    expect(observeOidcDiagnostic).toHaveBeenCalled();
  });

  it("fails before GitHub I/O when the pre-mint observation is not acknowledged", async () => {
    const observerFailure = "private pre-mint observer failure";
    const githubRequests: Request[] = [];
    const fetchExternal = vi.fn<typeof fetch>((input, init) => {
      const request = new Request(input, init);

      if (new URL(request.url).hostname === "token.actions.githubusercontent.com") {
        return fetchOidcRemoteDocumentResponseTestDouble(request);
      }

      githubRequests.push(request);

      return fetchGitHubTestDouble(request);
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const worker = createTokenExchangeWorker(testTokenExchangeComposition, {
      fetch: fetchExternal,
      now: () => testNow,
      observe: async (observation) => {
        if (observation.fields["event"] === "installation_access_token_issuance_started") {
          throw new Error(observerFailure);
        }
      },
      observeOidcDiagnostic: () => undefined,
    });

    try {
      const response = await invokeWorker(worker, await tokenRequest());

      await expectSanitizedServerError(response);
      expect(githubRequests).toEqual([]);
      expectSanitizedLog(consoleError, observerFailure, "ghs_test_token");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("rejects a malformed subject token without provider or GitHub I/O", async () => {
    const body = new URLSearchParams(await tokenExchangeRequestBody());
    body.set("subject_token", "not-a-jwt");
    const fetchExternal = vi.fn<typeof fetch>();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchExternal);

    try {
      const worker = createTokenExchangeWorker(testTokenExchangeComposition);
      const response = await invokeWorker(
        worker,
        new Request("https://example.test/token", {
          body,
          headers: {
            "cf-ray": "fixture-ray-id",
            "content-type": "application/x-www-form-urlencoded",
            "user-agent": "fixture-test-agent",
          },
          method: "POST",
        }),
      );

      expect(response.status).toBe(400);
      expect(response.headers.get("www-authenticate")).toBeNull();
      await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
      expect(fetchExternal).not.toHaveBeenCalled();
      expect(consoleWarn).toHaveBeenCalledExactlyOnceWith("OIDC authentication failed", {
        diagnosticCode: "ERR_JWT_INVALID",
        path: "/token",
        rayId: "fixture-ray-id",
        reason: "invalid_token",
        userAgent: "fixture-test-agent",
      });
    } finally {
      vi.unstubAllGlobals();
      consoleWarn.mockRestore();
    }
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
    expect(getPrivateKey).toHaveBeenCalledOnce();
  });

  it("reuses OIDC caches for the Worker lifetime", async () => {
    const sharedFetch = vi.fn<typeof fetch>((input, init) => {
      const url = new Request(input).url;

      return url.startsWith("https://token.actions.githubusercontent.com/")
        ? fetchOidcRemoteDocumentResponseTestDouble(input)
        : fetchGitHubTestDouble(input, init);
    });
    const worker = createTokenExchangeWorker(testTokenExchangeComposition, {
      fetch: sharedFetch,
      now: () => testNow,
      observe: async () => undefined,
    });

    expect((await invokeWorker(worker, await tokenRequest())).status).toBe(200);
    expect((await invokeWorker(worker, await tokenRequest())).status).toBe(200);
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
      const response = await invokeWorker(worker, await tokenRequest());

      expect(response.status).toBe(200);
      expect(fetchExternal).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("captures composition and runtime dependencies when constructed", async () => {
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

    const response = await invokeWorker(worker, await tokenRequest());

    expect(response.status).toBe(200);
    expect(initialFetch).toHaveBeenCalled();
    expect(replacementFetch).not.toHaveBeenCalled();
  });

  it("rebuilds the runtime when GitHub App credentials change", async () => {
    const observedIssuers: unknown[] = [];
    const fetchExternal = vi.fn<typeof fetch>((input, init) => {
      const request = new Request(input, init);

      if (new URL(request.url).hostname === "token.actions.githubusercontent.com") {
        return fetchOidcRemoteDocumentResponseTestDouble(request);
      }

      const authorization = request.headers.get("authorization");
      observedIssuers.push(
        authorization === null ? undefined : decodeJwt(authorization.slice("Bearer ".length)).iss,
      );

      return fetchGitHubTestDouble(request);
    });
    const worker = createTokenExchangeWorker(testTokenExchangeComposition, {
      fetch: fetchExternal,
      now: () => testNow,
      observe: async () => undefined,
      observeOidcDiagnostic: () => undefined,
    });
    const originalEnv = { ...testEnv, GITHUB_APP_ID: "111" };
    const changedEnv = { ...testEnv, GITHUB_APP_ID: "222" };

    const methodResponse = await invokeWorker(
      worker,
      new Request("https://example.test/token"),
      originalEnv,
    );
    const tokenResponse = await invokeWorker(worker, await tokenRequest(), changedEnv);

    expect(methodResponse.status).toBe(400);
    expect(tokenResponse.status).toBe(200);
    expect(observedIssuers).toEqual(["222", "222"]);
  });

  it("keeps each overlapping request on the GitHub App selected before admission", async () => {
    const observedIssuers: unknown[] = [];
    const fetchExternal = vi.fn<typeof fetch>((input, init) => {
      const request = new Request(input, init);

      if (new URL(request.url).hostname === "token.actions.githubusercontent.com") {
        return fetchOidcRemoteDocumentResponseTestDouble(request);
      }

      const authorization = request.headers.get("authorization");
      observedIssuers.push(
        authorization === null ? undefined : decodeJwt(authorization.slice("Bearer ".length)).iss,
      );

      return fetchGitHubTestDouble(request);
    });
    let releaseAppA: () => void = () => undefined;
    let markAppAWaiting: () => void = () => undefined;
    const appARelease = new Promise<void>((resolve) => {
      releaseAppA = resolve;
    });
    const appAWaiting = new Promise<void>((resolve) => {
      markAppAWaiting = resolve;
    });
    const worker = createTokenExchangeWorker(testTokenExchangeComposition, {
      fetch: fetchExternal,
      now: () => testNow,
      observe: async () => undefined,
      observeOidcDiagnostic: () => undefined,
    });
    const appAEnv = {
      ...testEnv,
      GITHUB_APP_ID: "111",
      TOKEN_EXCHANGE_RATE_LIMIT: {
        limit: async () => {
          markAppAWaiting();
          await appARelease;

          return { success: true };
        },
      },
    };
    const appBEnv = { ...testEnv, GITHUB_APP_ID: "222" };

    const appAResponsePromise = invokeWorker(worker, await tokenRequest(), appAEnv);
    await appAWaiting;
    const appBResponse = await invokeWorker(worker, await tokenRequest(), appBEnv);
    releaseAppA();
    const appAResponse = await appAResponsePromise;

    expect(appAResponse.status).toBe(200);
    expect(appBResponse.status).toBe(200);
    expect(observedIssuers).toEqual(["222", "222", "111", "111"]);
  });

  it("sanitizes a changed audience after configuration is cached", async () => {
    const worker = createTokenExchangeWorker(
      testTokenExchangeComposition,
      testTokenExchangeWorkerRuntimeDependencies,
    );

    expect((await invokeWorker(worker, new Request("https://example.test/not-token"))).status).toBe(
      404,
    );
    const response = await invokeWorker(worker, new Request("https://example.test/not-token"), {
      ...testEnv,
      TOKEN_BROKER_AUDIENCE: "https://different-broker.example",
    });

    await expectSanitizedServerError(response);
  });

  it("sanitizes a rejected rate-limit binding call without leaking its detail", async () => {
    const failureDetail = "rate limit binding leaked detail";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const worker = createTokenExchangeWorker(testTokenExchangeComposition, {
      ...testTokenExchangeWorkerRuntimeDependencies,
      fetch: vi.fn<typeof fetch>(),
    });

    try {
      const response = await invokeWorker(worker, await tokenRequest(), {
        ...testEnv,
        TOKEN_EXCHANGE_RATE_LIMIT: {
          limit: async () => Promise.reject(new Error(failureDetail)),
        },
      });

      await expectSanitizedServerError(response);
      expectSanitizedLog(consoleError, failureDetail);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("sanitizes invalid audience configuration without leaking its detail", async () => {
    const failureDetail = "private invalid audience detail";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const worker = createTokenExchangeWorker(
      testTokenExchangeComposition,
      testTokenExchangeWorkerRuntimeDependencies,
    );

    try {
      const response = await invokeWorker(worker, await tokenRequest(), {
        ...testEnv,
        TOKEN_BROKER_AUDIENCE: `invalid\n${failureDetail}`,
      });

      await expectSanitizedServerError(response);
      expectSanitizedLog(consoleError, failureDetail);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("sanitizes URL routing failures at the Worker boundary", async () => {
    const failureDetail = "private URL routing failure";
    const request = new Request("https://example.test/token", { method: "GET" });
    Object.defineProperty(request, "url", {
      get() {
        throw new Error(failureDetail);
      },
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const worker = createTokenExchangeWorker(
      testTokenExchangeComposition,
      testTokenExchangeWorkerRuntimeDependencies,
    );

    try {
      const response = await invokeWorker(worker, request);

      await expectSanitizedServerError(response);
      expectSanitizedLog(consoleError, failureDetail);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("sanitizes response-construction failure before the protocol handler", async () => {
    const failureDetail = "private non-POST response failure";
    const PlatformResponse = Response;
    let constructionCount = 0;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "Response",
      class extends PlatformResponse {
        constructor(body?: BodyInit | null, init?: ResponseInit) {
          constructionCount += 1;

          if (constructionCount === 1) {
            throw new Error(failureDetail);
          }

          super(body, init);
        }
      },
    );
    const worker = createTokenExchangeWorker(
      testTokenExchangeComposition,
      testTokenExchangeWorkerRuntimeDependencies,
    );

    try {
      const response = await invokeWorker(
        worker,
        new Request("https://example.test/token", { method: "GET" }),
      );

      await expectSanitizedServerError(response);
      expectSanitizedLog(consoleError, failureDetail);
    } finally {
      vi.unstubAllGlobals();
      consoleError.mockRestore();
    }
  });

  it("sanitizes a final rejected protocol-handler promise", async () => {
    const failureDetail = "private final Token Endpoint rejection";
    const request = await tokenRequest();
    const PlatformResponse = Response;
    let constructionCount = 0;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "Response",
      class extends PlatformResponse {
        constructor(body?: BodyInit | null, init?: ResponseInit) {
          constructionCount += 1;

          if (constructionCount <= 2) {
            throw new Error(`${failureDetail} ${constructionCount}`);
          }

          super(body, init);
        }
      },
    );
    const worker = createTokenExchangeWorker(
      testTokenExchangeComposition,
      testTokenExchangeWorkerRuntimeDependencies,
    );

    try {
      const response = await invokeWorker(worker, request);

      await expectSanitizedServerError(response);
      expect(consoleError).toHaveBeenCalledTimes(2);
      expectSanitizedLog(consoleError, failureDetail);
    } finally {
      vi.unstubAllGlobals();
      consoleError.mockRestore();
    }
  });
});

async function tokenRequest(headers: Readonly<Record<string, string>> = {}): Promise<Request> {
  return new Request("https://example.test/token", {
    body: await tokenExchangeRequestBody(),
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    method: "POST",
  });
}

async function invokeWorker(
  worker: ExportedHandler<TokenExchangeWorkerEnv>,
  request: Request,
  env: TokenExchangeWorkerEnv = testEnv,
): Promise<Response> {
  const handler = worker.fetch;

  if (handler === undefined) {
    throw new Error("test Worker has no fetch handler");
  }

  return await handler(request as Parameters<typeof handler>[0], env, {} as ExecutionContext);
}

async function expectSanitizedServerError(response: Response): Promise<void> {
  expect(response.status).toBe(500);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(response.headers.get("www-authenticate")).toBeNull();
  await expect(response.json()).resolves.toEqual({ error: "server_error" });
}

function expectSanitizedLog(
  consoleError: ReturnType<typeof vi.spyOn>,
  ...privateDetails: readonly string[]
): void {
  expect(consoleError).toHaveBeenCalledWith({
    error: { name: "Error" },
    event: "token_exchange_request_failed",
  });
  for (const privateDetail of privateDetails) {
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(privateDetail);
  }
}
