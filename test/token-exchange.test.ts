import { describe, expect, it, vi } from "vitest";

import { handleTokenExchangeRequest } from "../workers/github-app-token-broker/src/token-exchange.ts";
import {
  accessTokenType,
  legacyGithubInstallationAccessTokenType,
  oidcIdTokenType,
  testNow,
  tokenExchangeGrantType,
} from "./support/constants.ts";

type EndpointRuntime = Parameters<typeof handleTokenExchangeRequest>[1];
type ExchangeInput = Parameters<EndpointRuntime["exchange"]>[0];
type ExchangeResult = Awaited<ReturnType<EndpointRuntime["exchange"]>>;

const tokenEndpoint = "https://example.test/token";
const tokenExpiresAt = "2026-05-24T01:00:00.000Z";

describe("Token Exchange protocol handler", () => {
  it("passes a normalized request to the exchange and returns the complete OAuth token response", async () => {
    const runtime = testRuntime();
    const response = await handleTokenExchangeRequest(tokenRequest(), runtime);

    await expectOAuthToken(response, {
      access_token: "ghs_test_token",
      expires_in: 3600,
      issued_token_type: accessTokenType,
      scope: "contents:write pull_requests:write",
      token_type: "Bearer",
    });
    expect(runtime.exchange).toHaveBeenCalledWith({
      request: expect.any(Request),
      subjectToken: "subject-token",
      tokenRequest: {
        permissions: { contents: "write", pull_requests: "write" },
        resource: {
          href: "https://api.github.com/repos/fixture-owner/fixture-source-repository",
          owner: "fixture-owner",
          repository: "fixture-source-repository",
        },
        scope: "contents:write pull_requests:write",
      },
    });
  });

  it("preserves the legacy requested-token-type contract", async () => {
    const response = await handleTokenExchangeRequest(
      tokenRequest({ requested_token_type: legacyGithubInstallationAccessTokenType }),
      testRuntime(),
    );

    await expectOAuthToken(response, {
      access_token: "ghs_test_token",
      expires_in: 3600,
      issued_token_type: legacyGithubInstallationAccessTokenType,
      scope: "contents:write pull_requests:write",
      token_type: "Bearer",
    });
  });

  it("canonicalizes reordered permission scopes before issuing", async () => {
    const runtime = testRuntime();
    const response = await handleTokenExchangeRequest(
      tokenRequest({ scope: "pull_requests:write contents:write" }),
      runtime,
    );

    await expectOAuthToken(response, {
      access_token: "ghs_test_token",
      expires_in: 3600,
      issued_token_type: accessTokenType,
      scope: "contents:write pull_requests:write",
      token_type: "Bearer",
    });
    expect(runtime.exchange).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenRequest: expect.objectContaining({ scope: "contents:write pull_requests:write" }),
      }),
    );
  });

  it.each([
    [
      "cf-connecting-ip takes precedence",
      { "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": "203.0.113.2, 203.0.113.3" },
      "198.51.100.1",
    ],
    [
      "x-forwarded-for is not trusted",
      { "x-forwarded-for": "203.0.113.2, 203.0.113.3" },
      "unknown",
    ],
    ["missing client headers falls back to unknown", {}, "unknown"],
  ])("uses the correct rate-limit key when %s", async (_caseName, headers, key) => {
    const runtime = testRuntime({ rateLimit: vi.fn(async () => false) });
    const response = await handleTokenExchangeRequest(tokenRequest({}, headers), runtime);

    await expectOAuthError(response, 429, "temporarily_unavailable");
    expect(runtime.rateLimit).toHaveBeenCalledExactlyOnceWith(key);
    expect(runtime.exchange).not.toHaveBeenCalled();
  });

  it("rate limits before inspecting authentication or parsing a body", async () => {
    const runtime = testRuntime({ rateLimit: vi.fn(async () => false) });
    const response = await handleTokenExchangeRequest(
      new Request(tokenEndpoint, {
        body: "not-a-form",
        headers: {
          authorization: "Basic ignored",
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      }),
      runtime,
    );

    await expectOAuthError(response, 429, "temporarily_unavailable");
    expect(runtime.exchange).not.toHaveBeenCalled();
  });

  it("sanitizes a rejected rate-limit operation", async () => {
    const failureDetail = "private rate-limit failure detail";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await handleTokenExchangeRequest(
        tokenRequest(),
        testRuntime({ rateLimit: vi.fn(async () => Promise.reject(new Error(failureDetail))) }),
      );

      await expectSanitizedServerError(response, consoleError, failureDetail);
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each([
    ["Basic dW5zdXBwb3J0ZWQ=", 'Basic realm="github-app-token-broker"'],
    ["Bearer subject-token", 'Bearer realm="github-app-token-broker"'],
    ["1invalid credentials", 'Basic realm="github-app-token-broker"'],
  ])(
    "rejects unsupported client authentication with the %s challenge",
    async (authorization, challenge) => {
      const runtime = testRuntime();
      const response = await handleTokenExchangeRequest(
        tokenRequest({}, { authorization }),
        runtime,
      );

      await expectOAuthError(response, 401, "invalid_client", challenge);
      expect(runtime.exchange).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "application/json", "text/plain; charset=utf-8"])(
    "requires a form-url-encoded request body (%s)",
    async (contentType) => {
      const runtime = testRuntime();
      const request = tokenRequest(
        {},
        contentType === undefined ? {} : { "content-type": contentType },
      );

      if (contentType === undefined) {
        request.headers.delete("content-type");
      }

      const response = await handleTokenExchangeRequest(request, runtime);

      await expectOAuthError(response, 400, "invalid_request");
      expect(runtime.exchange).not.toHaveBeenCalled();
    },
  );

  it("rejects bodies beyond the Token Endpoint limit before exchange", async () => {
    const runtime = testRuntime();
    const response = await handleTokenExchangeRequest(
      new Request(tokenEndpoint, {
        body: `grant_type=x&subject_token=${"x".repeat(64 * 1024)}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      runtime,
    );

    await expectOAuthError(response, 413, "invalid_request");
    expect(runtime.exchange).not.toHaveBeenCalled();
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
    [
      "non-empty audience",
      { audience: "https://github.com/apps/github-app-token-broker" },
      "invalid_target",
    ],
    ["missing scope", { scope: null }, "invalid_scope"],
    ["empty scope", { scope: "" }, "invalid_scope"],
    ["padded scope", { scope: " contents:write" }, "invalid_scope"],
    [
      "malformed resource",
      { resource: "https://github.com/fixture-owner/fixture-source-repository" },
      "invalid_target",
    ],
  ])("rejects $0 with $2", async (_caseName, form, error) => {
    const runtime = testRuntime();
    const response = await handleTokenExchangeRequest(tokenRequest(form), runtime);

    await expectOAuthError(response, 400, error);
    expect(runtime.exchange).not.toHaveBeenCalled();
  });

  it.each([
    ["actor_token", "actor"],
    ["actor_token_type", "urn:example:actor-token"],
    ["authorization_details", "{}"],
    ["client_assertion", "assertion"],
    ["client_assertion_type", "urn:example:client-assertion"],
    ["client_id", "client"],
    ["client_secret", "secret"],
  ] as const)("rejects non-empty unsupported %s", async (field, value) => {
    const runtime = testRuntime();
    const response = await handleTokenExchangeRequest(tokenRequest({ [field]: value }), runtime);

    await expectOAuthError(response, 400, "invalid_request");
    expect(runtime.exchange).not.toHaveBeenCalled();
  });

  it.each([
    "actor_token",
    "actor_token_type",
    "authorization_details",
    "client_assertion",
    "client_assertion_type",
    "client_id",
    "client_secret",
  ] as const)("treats empty unsupported %s as omitted", async (field) => {
    const runtime = testRuntime();
    const response = await handleTokenExchangeRequest(tokenRequest({ [field]: "" }), runtime);

    await expectOAuthToken(response, {
      access_token: "ghs_test_token",
      expires_in: 3600,
      issued_token_type: accessTokenType,
      scope: "contents:write pull_requests:write",
      token_type: "Bearer",
    });
    expect(runtime.exchange).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "duplicate grant types",
      (form: URLSearchParams) => form.append("grant_type", "urn:example:duplicate"),
      "invalid_request",
    ],
    [
      "duplicate resources",
      (form: URLSearchParams) =>
        form.append("resource", "https://api.github.com/repos/other/repository"),
      "invalid_target",
    ],
    [
      "duplicate audiences",
      (form: URLSearchParams) => form.append("audience", "https://github.com/apps/other"),
      "invalid_target",
    ],
  ])("rejects %s", async (_caseName, mutate, error) => {
    const runtime = testRuntime();
    const form = validForm();
    mutate(form);
    const response = await handleTokenExchangeRequest(formRequest(form), runtime);

    await expectOAuthError(response, 400, error);
    expect(runtime.exchange).not.toHaveBeenCalled();
  });

  it("rejects repeated empty resources when no non-empty resource is present", async () => {
    const runtime = testRuntime();
    const form = validForm();
    form.delete("resource");
    form.append("resource", "");
    form.append("resource", "");

    const response = await handleTokenExchangeRequest(formRequest(form), runtime);

    await expectOAuthError(response, 400, "invalid_target");
    expect(runtime.exchange).not.toHaveBeenCalled();
  });

  it.each([
    ["empty duplicate grant type", (form: URLSearchParams) => form.append("grant_type", "")],
    ["empty resource occurrence", (form: URLSearchParams) => form.append("resource", "")],
  ])("treats %s as omitted", async (_caseName, mutate) => {
    const runtime = testRuntime();
    const form = validForm();
    mutate(form);
    const response = await handleTokenExchangeRequest(formRequest(form), runtime);

    expect(response.status).toBe(200);
    expect(runtime.exchange).toHaveBeenCalledOnce();
  });

  it("treats a leading empty single-valued occurrence as omitted", async () => {
    const runtime = testRuntime();
    const form = new URLSearchParams([["grant_type", ""], ...validForm()]);
    const response = await handleTokenExchangeRequest(formRequest(form), runtime);

    expect(response.status).toBe(200);
    expect(runtime.exchange).toHaveBeenCalledWith({
      request: expect.any(Request),
      subjectToken: "subject-token",
      tokenRequest: {
        permissions: { contents: "write", pull_requests: "write" },
        resource: {
          href: "https://api.github.com/repos/fixture-owner/fixture-source-repository",
          owner: "fixture-owner",
          repository: "fixture-source-repository",
        },
        scope: "contents:write pull_requests:write",
      },
    });
  });

  it.each<readonly [string, ExchangeResult, number, string]>([
    [
      "invalid OIDC token",
      { ok: false, reason: "invalid_token", stage: "authentication" },
      400,
      "invalid_request",
    ],
    [
      "OIDC provider failure",
      { ok: false, reason: "oidc_provider_failure", stage: "authentication" },
      503,
      "temporarily_unavailable",
    ],
    [
      "internal OIDC failure",
      { ok: false, reason: "oidc_internal_failure", stage: "authentication" },
      500,
      "server_error",
    ],
    [
      "policy target failure",
      { ok: false, reason: "target_unsupported", stage: "authorization" },
      400,
      "invalid_target",
    ],
    [
      "policy permission failure",
      { ok: false, reason: "requested_permissions_unsupported", stage: "authorization" },
      400,
      "invalid_scope",
    ],
    [
      "policy subject failure",
      { ok: false, reason: "subject_token_unacceptable", stage: "authorization" },
      400,
      "invalid_request",
    ],
    [
      "GitHub upstream failure",
      { ok: false, reason: "upstream_failure", stage: "issuance" },
      502,
      "server_error",
    ],
    [
      "GitHub upstream unavailable",
      { ok: false, reason: "upstream_unavailable", stage: "issuance" },
      503,
      "temporarily_unavailable",
    ],
    [
      "issuance internal failure",
      { ok: false, reason: "internal_failure", stage: "issuance" },
      500,
      "server_error",
    ],
  ])("maps $0 to its OAuth error", async (_caseName, result, status, error) => {
    const response = await handleTokenExchangeRequest(
      tokenRequest(),
      testRuntime({ exchange: vi.fn(async () => result) }),
    );

    await expectOAuthError(response, status, error);
  });

  it("returns zero expiry for an invalid upstream expiry timestamp", async () => {
    const response = await handleTokenExchangeRequest(
      tokenRequest(),
      testRuntime({
        exchange: vi.fn(async () => ({
          expiresAt: "not-a-timestamp",
          ok: true as const,
          token: "ghs_test_token",
        })),
      }),
    );

    await expectOAuthToken(response, {
      access_token: "ghs_test_token",
      expires_in: 0,
      issued_token_type: accessTokenType,
      scope: "contents:write pull_requests:write",
      token_type: "Bearer",
    });
  });

  it("sanitizes a failing request body stream", async () => {
    const failureDetail = "subject_token=secret-body-stream-detail";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(failureDetail));
      },
    });

    try {
      const response = await handleTokenExchangeRequest(
        new Request(tokenEndpoint, {
          body,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          method: "POST",
        }),
        testRuntime(),
      );

      await expectSanitizedServerError(response, consoleError, failureDetail);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("sanitizes an unexpected exchange rejection", async () => {
    const failureDetail = "subject token or upstream secret detail";
    const failure = new Error(failureDetail);
    failure.name = "SecretSubjectTokenError";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await handleTokenExchangeRequest(
        tokenRequest(),
        testRuntime({ exchange: vi.fn(async () => Promise.reject(failure)) }),
      );

      await expectSanitizedServerError(response, consoleError, failureDetail);
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(failure.name);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("sanitizes an unexpected response-construction failure", async () => {
    const failureDetail = "response construction secret detail";
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

    try {
      const response = await handleTokenExchangeRequest(tokenRequest(), testRuntime());

      await expectSanitizedServerError(response, consoleError, failureDetail);
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("ghs_test_token");
    } finally {
      vi.unstubAllGlobals();
      consoleError.mockRestore();
    }
  });
});

function testRuntime(overrides: Partial<EndpointRuntime> = {}) {
  const exchange = vi.fn(async (_input: ExchangeInput): Promise<ExchangeResult> => ({
    expiresAt: tokenExpiresAt,
    ok: true,
    token: "ghs_test_token",
  }));
  const rateLimit = vi.fn(async (_key: string) => true);

  return { exchange, now: () => testNow, rateLimit, ...overrides } satisfies EndpointRuntime;
}

function tokenRequest(
  formOverrides: Record<string, string | null> = {},
  headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" },
): Request {
  return formRequest(validForm(formOverrides), headers);
}

function validForm(overrides: Record<string, string | null> = {}): URLSearchParams {
  const form = new URLSearchParams({
    grant_type: tokenExchangeGrantType,
    requested_token_type: accessTokenType,
    resource: "https://api.github.com/repos/fixture-owner/fixture-source-repository",
    scope: "contents:write pull_requests:write",
    subject_token: "subject-token",
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
  form: URLSearchParams,
  headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" },
): Request {
  return new Request(tokenEndpoint, { body: form, headers, method: "POST" });
}

async function expectOAuthError(
  response: Response,
  status: number,
  error: string,
  challenge: string | null = null,
) {
  expectOAuthResponseHeaders(response, status, challenge);
  await expect(response.json()).resolves.toEqual({ error });
}

async function expectOAuthToken(response: Response, body: Record<string, string | number>) {
  expectOAuthResponseHeaders(response, 200, null);
  await expect(response.json()).resolves.toEqual(body);
}

function expectOAuthResponseHeaders(response: Response, status: number, challenge: string | null) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(response.headers.get("www-authenticate")).toBe(challenge);
}

async function expectSanitizedServerError(
  response: Response,
  consoleError: ReturnType<typeof vi.spyOn>,
  privateDetail: string,
) {
  await expectOAuthError(response, 500, "server_error");
  expect(consoleError).toHaveBeenCalledWith({
    error: { name: "Error" },
    event: "token_exchange_request_failed",
  });
  expect(JSON.stringify(consoleError.mock.calls)).not.toContain(privateDetail);
}
