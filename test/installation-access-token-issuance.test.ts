import { afterEach, describe, expect, it, vi } from "vitest";
import type { VerifiedSubjectToken } from "@github-app-token-broker/oidc/id-token-authenticator";

import { issueInstallationAccessTokenForContext } from "../workers/github-app-token-broker/src/policy/installation-access-token-issuance.ts";
import { testNow, testRepository, testInstallationId } from "./support/constants.ts";
import { fetchGitHubTestDouble, githubInstallationResponse } from "./support/github-api.ts";
import { createVerifiedSubjectToken } from "./support/oidc.ts";
import { testTokenIssuancePolicy } from "./support/token-issuance-policy.ts";
import { testEnv } from "./support/worker-env.ts";
import {
  compileTokenIssuancePolicy,
  githubRepositoryResourceConstraint,
  oidcSubjectTokenConstraint,
} from "@github-app-token-broker/token-issuance-policy";

const application = {
  githubApp: testEnv,
  tokenIssuancePolicy: testTokenIssuancePolicy,
};

const tokenRequest = {
  permissions: {
    contents: "write",
    pull_requests: "write",
  },
  resource: {
    href: "https://api.github.com/repos/fixture-owner/fixture-source-repository",
    owner: "fixture-owner",
    repository: "fixture-source-repository",
  },
  scope: "contents:write pull_requests:write",
} as const;

const verifiedSubjectToken: VerifiedSubjectToken = createVerifiedSubjectToken({
  actor: "dependabot[bot]",
  event_name: "workflow_dispatch",
  ref: "refs/heads/fixture-base-branch",
  ref_type: "branch",
  repository: testRepository,
  sub: "repo:fixture-owner/fixture-source-repository:ref:refs/heads/fixture-base-branch",
  workflow_ref:
    "fixture-owner/fixture-source-repository/.github/workflows/fixture-token-request.yml@refs/heads/fixture-base-branch",
});
const verificationEvidence = { resolvedKeyId: "test-key-1" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Installation Access Token Issuance", () => {
  it("does not fetch source repository metadata before minting", async () => {
    const requestedPaths: string[] = [];

    await expect(
      issueInstallationAccessToken({
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);

          requestedPaths.push(url.pathname);

          if (request.method === "GET" && url.pathname === `/repos/${testRepository}`) {
            throw new Error("source repository metadata should not be fetched");
          }

          return fetchGitHubTestDouble(input, init);
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
    });

    expect(requestedPaths).not.toContain(`/repos/${testRepository}`);
  });

  it("does not mint when installation resolution returns a different owner", async () => {
    const requestedRequests: Array<{ method: string; path: string }> = [];

    await expect(
      issueInstallationAccessToken({
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);

          requestedRequests.push({ method: request.method, path: url.pathname });

          if (
            request.method === "GET" &&
            url.pathname === `/repos/${testRepository}/installation`
          ) {
            return githubInstallationResponse("transferred-owner", testInstallationId);
          }

          return new Response(null, { status: 500 });
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "upstream_failure" });

    expect(requestedRequests).toEqual([
      { method: "GET", path: `/repos/${testRepository}/installation` },
    ]);
  });

  it("forwards arbitrary Requested Permissions and admin exactly to GitHub", async () => {
    const requestedPermissions = { future_permission: "admin", issues: "read" } as const;
    let forwardedBody: unknown;
    const policy = compileTokenIssuancePolicy([
      {
        permissions: requestedPermissions,
        resource: githubRepositoryResourceConstraint(
          tokenRequest.resource.owner,
          tokenRequest.resource.repository,
        ),
        subjectToken: oidcSubjectTokenConstraint(verifiedSubjectToken.issuer),
      },
    ]);

    await expect(
      issueInstallationAccessTokenForContext(
        application.githubApp,
        policy,
        { verifiedSubjectToken, verificationEvidence },
        {
          ...tokenRequest,
          permissions: requestedPermissions,
          scope: "future_permission:admin issues:read",
        },
        {
          fetch: async (input, init) => {
            const request = new Request(input, init);

            if (request.method === "POST") {
              forwardedBody = await request.json();

              return Response.json(
                {
                  expires_at: "2030-01-01T00:00:00Z",
                  permissions: requestedPermissions,
                  token: "ghs_arbitrary_permissions",
                },
                { status: 201 },
              );
            }

            return fetchGitHubTestDouble(input, init);
          },
          now: () => testNow,
        },
      ),
    ).resolves.toMatchObject({ ok: true, token: "ghs_arbitrary_permissions" });

    expect(forwardedBody).toEqual({
      permissions: requestedPermissions,
      repositories: [tokenRequest.resource.repository],
    });
  });

  it("logs GitHub Actions claims and issuance context on success", async () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await expect(
      issueInstallationAccessToken({ fetch: fetchGitHubTestDouble }),
    ).resolves.toMatchObject({
      ok: true,
      token: "ghs_test_token",
    });

    expect(consoleInfo).toHaveBeenCalledOnce();
    expect(consoleInfo.mock.calls[0]?.[0]).toMatchObject({
      event: "installation_access_token_issuance_succeeded",
      subject_token: {
        issuer: "https://token.actions.githubusercontent.com",
        resolved_key_id: "test-key-1",
        sub: "repo:fixture-owner/fixture-source-repository:ref:refs/heads/fixture-base-branch",
        subject_token_type: "id_token",
      },
      target_installation: { id: 67890, repository: testRepository },
      token_issuance_policy: { permitted: true },
      installation_access_token_request: {
        permissions: tokenRequest.permissions,
        resource: tokenRequest.resource.href,
        scope: tokenRequest.scope,
      },
      expires_at: "2030-01-01T00:00:00Z",
    });
    expectSafeIssuanceLog(consoleInfo.mock.calls, "ghs_test_token");
  });

  it.each([
    { githubStatus: 400, issuanceReason: "internal_failure", scenario: "bad request" },
    { githubStatus: 401, issuanceReason: "internal_failure", scenario: "bad credentials" },
    {
      githubStatus: 422,
      issuanceReason: "internal_failure",
      responseBody: "private GitHub validation detail",
      scenario: "validation rejection",
    },
    {
      githubStatus: 403,
      issuanceReason: "upstream_failure",
      responseBody: "not JSON",
      scenario: "forbidden with a malformed error body",
    },
    {
      githubStatus: 403,
      issuanceReason: "upstream_failure",
      responseBody: JSON.stringify({ message: 12345 }),
      scenario: "forbidden with an invalid error body",
    },
    {
      githubStatus: 403,
      headers: { "x-ratelimit-remaining": "0" },
      issuanceReason: "upstream_unavailable",
      scenario: "primary rate limit",
    },
    {
      githubStatus: 403,
      responseBody: JSON.stringify({ message: "You have exceeded a secondary rate limit." }),
      issuanceReason: "upstream_unavailable",
      scenario: "headerless secondary rate limit",
    },
    {
      githubStatus: 403,
      responseBody: oversizedRateLimitResponseBody(),
      issuanceReason: "upstream_failure",
      scenario: "oversized error body",
    },
    {
      githubStatus: 403,
      responseBody: unreadableResponseBody(),
      issuanceReason: "upstream_failure",
      scenario: "unreadable error body",
    },
    {
      githubStatus: 403,
      headers: { "retry-after": "60" },
      issuanceReason: "upstream_unavailable",
      scenario: "secondary rate limit",
    },
    { githubStatus: 404, issuanceReason: "upstream_failure", scenario: "hidden resource" },
    { githubStatus: 429, issuanceReason: "upstream_unavailable", scenario: "rate limit" },
    { githubStatus: 500, issuanceReason: "upstream_failure", scenario: "server failure" },
    { githubStatus: 503, issuanceReason: "upstream_unavailable", scenario: "unavailable" },
  ])(
    "maps GitHub $scenario during installation resolution to $issuanceReason",
    async ({ githubStatus, headers, issuanceReason, responseBody }) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const fetchGitHub = vi.fn(
        async () =>
          new Response(responseBody ?? "upstream failure", {
            ...(headers === undefined ? {} : { headers }),
            status: githubStatus,
          }),
      );

      await expect(issueInstallationAccessToken({ fetch: fetchGitHub })).resolves.toEqual({
        ok: false,
        reason: issuanceReason,
      });

      expect(fetchGitHub).toHaveBeenCalledOnce();
      expectIssuanceErrorLog(consoleError.mock.calls, {
        path: `/repos/${testRepository}/installation`,
        status: githubStatus,
        targetInstallationId: undefined,
        forbiddenValues: typeof responseBody === "string" ? [responseBody] : [],
      });
    },
  );

  it.each([
    { privateKey: "", scenario: "missing" },
    { privateKey: "not a private key", scenario: "invalid" },
  ])("maps a $scenario GitHub App private key to an internal failure", async ({ privateKey }) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchGitHub = vi.fn(fetchGitHubTestDouble);

    await expect(
      issueInstallationAccessTokenForContext(
        { ...application.githubApp, GITHUB_APP_PRIVATE_KEY: privateKey },
        application.tokenIssuancePolicy,
        { verifiedSubjectToken, verificationEvidence },
        tokenRequest,
        { fetch: fetchGitHub, now: () => testNow },
      ),
    ).resolves.toEqual({ ok: false, reason: "internal_failure" });

    expect(fetchGitHub).not.toHaveBeenCalled();
    expectIssuanceErrorLog(consoleError.mock.calls, {
      message: "invalid GitHub App configuration",
      targetInstallationId: undefined,
      forbiddenValues: privateKey.length > 0 ? [privateKey] : [],
    });
  });

  it.each([
    { githubStatus: 404, issuanceReason: "upstream_failure" },
    { githubStatus: 503, issuanceReason: "upstream_unavailable" },
    {
      githubStatus: 403,
      issuanceReason: "upstream_unavailable",
      responseBody: JSON.stringify({ message: "You have exceeded a secondary rate limit." }),
    },
  ])(
    "logs the resolved installation when token minting fails with GitHub $githubStatus as $issuanceReason",
    async ({ githubStatus, issuanceReason, responseBody }) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await expect(
        issueInstallationAccessToken({
          fetch: async (input, init) => {
            const request = new Request(input, init);

            return request.method === "POST"
              ? new Response(responseBody ?? "upstream failure", { status: githubStatus })
              : fetchGitHubTestDouble(input, init);
          },
        }),
      ).resolves.toEqual({ ok: false, reason: issuanceReason });

      expectIssuanceErrorLog(consoleError.mock.calls, {
        path: `/app/installations/${testInstallationId}/access_tokens`,
        status: githubStatus,
        targetInstallationId: testInstallationId,
      });
    },
  );

  it("maps a network error to upstream unavailability without leaking its message", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      issueInstallationAccessToken({
        fetch: async () => {
          throw new Error("private network failure details");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "upstream_unavailable" });

    expectIssuanceErrorLog(consoleError.mock.calls, {
      path: "/repos/fixture-owner/fixture-source-repository/installation",
      targetInstallationId: undefined,
      forbiddenValues: ["private network failure details"],
    });
  });

  it("maps an unreadable successful installation response body to upstream unavailability", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const privateResponseToken = "ghs_private_installation_body_token";
    const privateResponseContent = `private installation response content ${privateResponseToken}`;
    const privateStreamError = "private installation response body read failure";

    await expect(
      issueInstallationAccessToken({
        fetch: async () =>
          new Response(unreadableResponseBody(privateResponseContent, privateStreamError)),
      }),
    ).resolves.toEqual({ ok: false, reason: "upstream_unavailable" });

    expectIssuanceErrorLog(consoleError.mock.calls, {
      path: "/repos/fixture-owner/fixture-source-repository/installation",
      targetInstallationId: undefined,
      forbiddenValues: [privateStreamError, privateResponseContent, privateResponseToken],
    });
  });

  it("maps malformed successful GitHub JSON to an upstream failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const malformedResponseBody = '{"private":"response content"';

    await expect(
      issueInstallationAccessToken({
        fetch: async () => new Response(malformedResponseBody),
      }),
    ).resolves.toEqual({ ok: false, reason: "upstream_failure" });

    expectIssuanceErrorLog(consoleError.mock.calls, {
      message:
        "GitHub API returned an invalid response: /repos/fixture-owner/fixture-source-repository/installation",
      status: 200,
      targetInstallationId: undefined,
      forbiddenValues: [malformedResponseBody],
    });
  });

  it("maps a token-minting network error to upstream unavailability", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      issueInstallationAccessToken({
        fetch: async (input, init) => {
          const request = new Request(input, init);

          if (request.method === "POST") {
            throw new Error("private token-minting network failure details");
          }

          return fetchGitHubTestDouble(input, init);
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "upstream_unavailable" });

    expectIssuanceErrorLog(consoleError.mock.calls, {
      path: `/app/installations/${testInstallationId}/access_tokens`,
      targetInstallationId: testInstallationId,
      forbiddenValues: ["private token-minting network failure details"],
    });
  });

  it("maps an unreadable successful token-mint response body to upstream unavailability", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const privateResponseToken = "ghs_private_token_mint_body_token";
    const privateResponseContent = `private token-mint response content ${privateResponseToken}`;
    const privateStreamError = "private token-mint response body read failure";

    await expect(
      issueInstallationAccessToken({
        fetch: async (input, init) => {
          const request = new Request(input, init);

          return request.method === "POST"
            ? new Response(unreadableResponseBody(privateResponseContent, privateStreamError))
            : fetchGitHubTestDouble(input, init);
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "upstream_unavailable" });

    expectIssuanceErrorLog(consoleError.mock.calls, {
      path: `/app/installations/${testInstallationId}/access_tokens`,
      targetInstallationId: testInstallationId,
      forbiddenValues: [privateStreamError, privateResponseContent, privateResponseToken],
    });
  });

  it("logs when policy does not permit issuance without requesting GitHub", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchGitHub = vi.fn(fetchGitHubTestDouble);

    await expect(
      issueInstallationAccessTokenForContext(
        application.githubApp,
        application.tokenIssuancePolicy,
        {
          verifiedSubjectToken: {
            ...verifiedSubjectToken,
            claims: {
              ...verifiedSubjectToken.claims,
              event_name: "push",
            },
          },
          verificationEvidence,
        },
        tokenRequest,
        { fetch: fetchGitHub, now: () => testNow },
      ),
    ).resolves.toEqual({ ok: false, reason: "subject_token_unacceptable" });

    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "installation_access_token_issuance_failed",
        subject_token: expect.objectContaining({
          issuer: "https://token.actions.githubusercontent.com",
          sub: "repo:fixture-owner/fixture-source-repository:ref:refs/heads/fixture-base-branch",
        }),
        token_issuance_policy: { permitted: false },
        installation_access_token_request: {
          permissions: tokenRequest.permissions,
          resource: tokenRequest.resource.href,
          scope: tokenRequest.scope,
        },
      }),
    );
    expect(fetchGitHub).not.toHaveBeenCalled();
    expectSafeIssuanceLog(consoleError.mock.calls);
  });
});

function oversizedRateLimitResponseBody(): ReadableStream<Uint8Array> {
  const body = new TextEncoder().encode(
    JSON.stringify({ message: `rate limit ${"x".repeat(16 * 1024)}` }),
  );

  return new ReadableStream<Uint8Array>(
    {
      cancel: () => new Promise<void>(() => undefined),
      pull(controller) {
        controller.enqueue(body);
      },
    },
    { highWaterMark: 0 },
  );
}

function unreadableResponseBody(
  partialBody = "",
  errorMessage = "response body read failed",
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (partialBody.length > 0) {
        controller.enqueue(new TextEncoder().encode(partialBody));
      }
      controller.error(new Error(errorMessage));
    },
  });
}

interface IssuanceErrorLogOptions {
  readonly forbiddenValues?: readonly string[];
  readonly message?: string;
  readonly path?: string;
  readonly status?: number;
  readonly targetInstallationId: number | undefined;
}

function expectIssuanceErrorLog(logCalls: unknown, options: IssuanceErrorLogOptions): void {
  const message =
    options.message ??
    (options.path === undefined ? undefined : `GitHub API request failed: ${options.path}`);

  expect(logCalls).toContainEqual([
    expect.objectContaining({
      error: expect.objectContaining({
        ...(message === undefined ? {} : { message }),
        status: options.status,
      }),
      event: "installation_access_token_issuance_failed",
      subject_token: expect.objectContaining({
        issuer: verifiedSubjectToken.issuer,
        resolved_key_id: verificationEvidence.resolvedKeyId,
        sub: verifiedSubjectToken.claims.sub,
        subject_token_type: "id_token",
      }),
      target_installation: { id: options.targetInstallationId },
      token_issuance_policy: { permitted: true },
      installation_access_token_request: {
        permissions: tokenRequest.permissions,
        resource: tokenRequest.resource.href,
        scope: tokenRequest.scope,
      },
    }),
  ]);
  expectSafeIssuanceLog(logCalls, ...(options.forbiddenValues ?? []));
}

function expectSafeIssuanceLog(logCalls: unknown, ...forbiddenValues: readonly string[]): void {
  const serializedLogCalls = JSON.stringify(logCalls);

  expect(serializedLogCalls).not.toMatch(/rule_id|deny_reasons|matched|"claims"/u);
  for (const forbiddenValue of forbiddenValues) {
    expect(serializedLogCalls).not.toContain(forbiddenValue);
  }
  expectLogsNotToContainGitHubAppCredentials(logCalls);
}

function expectLogsNotToContainGitHubAppCredentials(logCalls: unknown): void {
  const serializedLogCalls = JSON.stringify(logCalls);

  expect(serializedLogCalls).not.toContain(testEnv.GITHUB_APP_ID);
  expect(serializedLogCalls).not.toContain(testEnv.GITHUB_APP_PRIVATE_KEY);
}

function issueInstallationAccessToken(
  dependencies: Omit<Parameters<typeof issueInstallationAccessTokenForContext>[4], "now">,
) {
  return issueInstallationAccessTokenForContext(
    application.githubApp,
    application.tokenIssuancePolicy,
    { verifiedSubjectToken, verificationEvidence },
    tokenRequest,
    { ...dependencies, now: () => testNow },
  );
}
