import { afterEach, describe, expect, it, vi } from "vitest";
import type { VerifiedSubjectToken } from "@github-app-token-broker/oidc/id-token-authenticator";

import {
  issueInstallationAccessTokenForContext,
  type InstallationAccessTokenIssuanceOperations,
} from "../workers/github-app-token-broker/src/policy/installation-access-token-issuance.ts";
import { GitHubApiError, GitHubApiTransportError } from "../packages/github/src/http.ts";
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
        subject_token_kind: "id_token",
      },
      target_installation: { id: 67890, repository: testRepository },
      token_issuance_policy: { permitted: true },
      installation_access_token_request: {
        permissions: tokenRequest.permissions,
        resource: tokenRequest.resource.href,
        scope: tokenRequest.scope,
      },
      installation_access_token: {
        permissions: tokenRequest.permissions,
      },
      expires_at: "2030-01-01T00:00:00Z",
    });
    expectSafeIssuanceLog(consoleInfo.mock.calls, "ghs_test_token");
  });

  it.each([
    { error: new GitHubApiError(400, "bad request"), reason: "internal_failure" },
    { error: new GitHubApiError(401, "bad credentials"), reason: "internal_failure" },
    { error: new GitHubApiError(403, "forbidden"), reason: "upstream_failure" },
    { error: new GitHubApiError(404, "hidden resource"), reason: "upstream_failure" },
    { error: new GitHubApiError(429, "rate limited", true), reason: "upstream_unavailable" },
    { error: new GitHubApiError(500, "server failure"), reason: "upstream_failure" },
    { error: new GitHubApiError(503, "unavailable"), reason: "upstream_unavailable" },
    {
      error: new GitHubApiTransportError("GitHub API request failed: installation resolution"),
      reason: "upstream_unavailable",
    },
  ] as const)("maps a GitHub operation failure to $reason", async ({ error, reason }) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const operations = operationsThatRejectDuringInstallationResolution(error);

    await expect(
      issueInstallationAccessTokenForContext(
        application.githubApp,
        application.tokenIssuancePolicy,
        { verifiedSubjectToken, verificationEvidence },
        tokenRequest,
        { fetch: vi.fn(), now: () => testNow },
        operations,
      ),
    ).resolves.toEqual({ ok: false, reason });

    expect(operations.resolveInstallationForRepository).toHaveBeenCalledOnce();
    expect(operations.createInstallationAccessTokenForRepositoryName).not.toHaveBeenCalled();
    expectIssuanceErrorLog(consoleError.mock.calls, {
      message:
        error instanceof GitHubApiError || error instanceof GitHubApiTransportError
          ? error.message
          : "unexpected Installation Access Token Issuance error",
      ...(error instanceof GitHubApiError ? { status: error.upstreamStatus } : {}),
      targetInstallationId: undefined,
      forbiddenValues: [],
    });
  });

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
    { error: new GitHubApiError(404, "token endpoint missing"), reason: "upstream_failure" },
    {
      error: new GitHubApiError(503, "token endpoint unavailable"),
      reason: "upstream_unavailable",
    },
    { error: new GitHubApiError(403, "rate limited", true), reason: "upstream_unavailable" },
  ] as const)(
    "logs the resolved installation when token minting fails",
    async ({ error, reason }) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const operations = operationsThatRejectDuringTokenMinting(error);

      await expect(
        issueInstallationAccessTokenForContext(
          application.githubApp,
          application.tokenIssuancePolicy,
          { verifiedSubjectToken, verificationEvidence },
          tokenRequest,
          { fetch: vi.fn(), now: () => testNow },
          operations,
        ),
      ).resolves.toEqual({ ok: false, reason });

      expect(operations.resolveInstallationForRepository).toHaveBeenCalledOnce();
      expect(operations.createInstallationAccessTokenForRepositoryName).toHaveBeenCalledOnce();
      expectIssuanceErrorLog(consoleError.mock.calls, {
        message: error.message,
        status: error.upstreamStatus,
        targetInstallationId: testInstallationId,
      });
    },
  );

  it("maps unexpected GitHub operation failures to a sanitized internal failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const operations = operationsThatRejectDuringInstallationResolution(
      new Error("private network failure details"),
    );

    await expect(
      issueInstallationAccessTokenForContext(
        application.githubApp,
        application.tokenIssuancePolicy,
        { verifiedSubjectToken, verificationEvidence },
        tokenRequest,
        { fetch: vi.fn(), now: () => testNow },
        operations,
      ),
    ).resolves.toEqual({ ok: false, reason: "internal_failure" });

    expectIssuanceErrorLog(consoleError.mock.calls, {
      message: "unexpected Installation Access Token Issuance error",
      targetInstallationId: undefined,
      forbiddenValues: ["private network failure details"],
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

function operationsThatRejectDuringInstallationResolution(
  error: unknown,
): InstallationAccessTokenIssuanceOperations {
  return {
    createInstallationAccessTokenForRepositoryName: vi.fn(async () => ({
      expiresAt: "2030-01-01T00:00:00Z",
      permissions: {},
      token: "unused",
    })),
    resolveInstallationForRepository: vi.fn(async () => {
      throw error;
    }),
  };
}

function operationsThatRejectDuringTokenMinting(
  error: GitHubApiError,
): InstallationAccessTokenIssuanceOperations {
  return {
    createInstallationAccessTokenForRepositoryName: vi.fn(async () => {
      throw error;
    }),
    resolveInstallationForRepository: vi.fn(async () => ({ id: testInstallationId })),
  };
}

interface IssuanceErrorLogOptions {
  readonly forbiddenValues?: readonly string[];
  readonly message: string;
  readonly status?: number;
  readonly targetInstallationId: number | undefined;
}

function expectIssuanceErrorLog(logCalls: unknown, options: IssuanceErrorLogOptions): void {
  expect(logCalls).toContainEqual([
    expect.objectContaining({
      error: expect.objectContaining({
        message: options.message,
        status: options.status,
      }),
      event: "installation_access_token_issuance_failed",
      subject_token: expect.objectContaining({
        issuer: verifiedSubjectToken.issuer,
        resolved_key_id: verificationEvidence.resolvedKeyId,
        sub: verifiedSubjectToken.claims.sub,
        subject_token_kind: "id_token",
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
