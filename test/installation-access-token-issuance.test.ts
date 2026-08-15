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
import { createInstallationAccessTokenRequest } from "@github-app-token-broker/github/installation-access-token-request";

const application = {
  githubApp: testEnv,
  tokenIssuancePolicy: testTokenIssuancePolicy,
};

const tokenRequest = createInstallationAccessTokenRequest({
  owner: "fixture-owner",
  permissions: {
    contents: "write",
    pull_requests: "write",
  },
  repository: "fixture-source-repository",
});

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
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
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
    expectIssuanceErrorLog(consoleError.mock.calls, {
      message: `GitHub API returned an invalid response: /repos/${testRepository}/installation`,
      status: 502,
      upstreamStatus: 200,
    });
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
        createInstallationAccessTokenRequest({
          owner: tokenRequest.resource.owner,
          permissions: requestedPermissions,
          repository: tokenRequest.resource.repository,
        }),
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
      token_issuance_policy: { outcome: "permitted" },
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
    { reason: "internal_failure", status: 400 },
    { reason: "internal_failure", status: 401 },
    { reason: "upstream_failure", status: 403 },
    { reason: "upstream_failure", status: 404 },
    { reason: "upstream_unavailable", status: 429 },
    { reason: "upstream_failure", status: 500 },
    { reason: "upstream_unavailable", status: 503 },
  ] as const)(
    "maps a GitHub installation response with status $status to $reason",
    async ({ reason, status }) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const fetchGitHub = vi.fn(async () => new Response(null, { status }));

      await expect(
        issueInstallationAccessTokenForContext(
          application.githubApp,
          application.tokenIssuancePolicy,
          { verifiedSubjectToken, verificationEvidence },
          tokenRequest,
          { fetch: fetchGitHub, now: () => testNow },
        ),
      ).resolves.toEqual({ ok: false, reason });

      expect(fetchGitHub).toHaveBeenCalledOnce();
      expectIssuanceErrorLog(consoleError.mock.calls, {
        message: `GitHub API request failed: /repos/${testRepository}/installation`,
        status,
        upstreamStatus: status,
      });
    },
  );

  it("maps a GitHub transport failure to upstream unavailable", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchGitHub = vi.fn(async () => {
      throw new Error("private network failure details");
    });

    await expect(issueInstallationAccessToken({ fetch: fetchGitHub })).resolves.toEqual({
      ok: false,
      reason: "upstream_unavailable",
    });

    expect(fetchGitHub).toHaveBeenCalledOnce();
    expectIssuanceErrorLog(consoleError.mock.calls, {
      message: `GitHub API request failed: /repos/${testRepository}/installation`,
      forbiddenValues: ["private network failure details"],
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
      forbiddenValues: privateKey.length > 0 ? [privateKey] : [],
    });
  });

  it.each([
    { headers: undefined, reason: "upstream_failure", status: 404 },
    { headers: undefined, reason: "upstream_unavailable", status: 503 },
    {
      headers: { "x-ratelimit-remaining": "0" },
      reason: "upstream_unavailable",
      status: 403,
    },
  ] as const)(
    "classifies a token-mint response with status $status after installation resolution",
    async ({ headers, reason, status }) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const requestedMethods: string[] = [];

      await expect(
        issueInstallationAccessTokenForContext(
          application.githubApp,
          application.tokenIssuancePolicy,
          { verifiedSubjectToken, verificationEvidence },
          tokenRequest,
          {
            fetch: async (input, init) => {
              const request = new Request(input, init);
              requestedMethods.push(request.method);

              return request.method === "GET"
                ? githubInstallationResponse("fixture-owner", testInstallationId)
                : new Response(null, { ...(headers === undefined ? {} : { headers }), status });
            },
            now: () => testNow,
          },
        ),
      ).resolves.toEqual({ ok: false, reason });

      expect(requestedMethods).toEqual(["GET", "POST"]);
      expectIssuanceErrorLog(consoleError.mock.calls, {
        message: `GitHub API request failed: /app/installations/${testInstallationId}/access_tokens`,
        status,
        targetInstallationId: testInstallationId,
        upstreamStatus: status,
      });
    },
  );

  it("retains the resolved installation when token minting has a transport failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      issueInstallationAccessToken({
        fetch: async (input, init) => {
          const request = new Request(input, init);

          if (request.method === "GET") {
            return githubInstallationResponse("fixture-owner", testInstallationId);
          }

          throw new Error("private token-mint transport failure");
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "upstream_unavailable" });

    expectIssuanceErrorLog(consoleError.mock.calls, {
      forbiddenValues: ["private token-mint transport failure"],
      message: `GitHub API request failed: /app/installations/${testInstallationId}/access_tokens`,
      targetInstallationId: testInstallationId,
    });
  });

  it("maps an unexpected credential-binding failure to a sanitized internal failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const privateFailure = "private credential provider failure details";
    const privateErrorName = "PrivateCredentialProviderFailure";
    const credentialError = new Error(privateFailure);
    credentialError.name = privateErrorName;

    await expect(
      issueInstallationAccessTokenForContext(
        {
          ...application.githubApp,
          GITHUB_APP_PRIVATE_KEY: {
            get: async () => {
              throw credentialError;
            },
          },
        },
        application.tokenIssuancePolicy,
        { verifiedSubjectToken, verificationEvidence },
        tokenRequest,
        { fetch: vi.fn(), now: () => testNow },
      ),
    ).resolves.toEqual({ ok: false, reason: "internal_failure" });

    expectIssuanceErrorLog(consoleError.mock.calls, {
      message: "unexpected Installation Access Token Issuance error",
      forbiddenValues: [privateFailure, privateErrorName],
    });
  });

  it.each([
    {
      authenticationSubjectToken: {
        ...verifiedSubjectToken,
        claims: { ...verifiedSubjectToken.claims, event_name: "push" },
      },
      reason: "subject_token_unacceptable",
      request: tokenRequest,
    },
    {
      authenticationSubjectToken: verifiedSubjectToken,
      reason: "target_unsupported",
      request: createInstallationAccessTokenRequest({
        owner: "other-owner",
        permissions: tokenRequest.permissions,
        repository: tokenRequest.resource.repository,
      }),
    },
    {
      authenticationSubjectToken: verifiedSubjectToken,
      reason: "requested_permissions_unsupported",
      request: createInstallationAccessTokenRequest({
        owner: tokenRequest.resource.owner,
        permissions: { issues: "read" },
        repository: tokenRequest.resource.repository,
      }),
    },
  ] as const)(
    "maps policy outcome $reason without requesting GitHub",
    async ({ authenticationSubjectToken, reason, request }) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const fetchGitHub = vi.fn(fetchGitHubTestDouble);

      await expect(
        issueInstallationAccessTokenForContext(
          application.githubApp,
          application.tokenIssuancePolicy,
          {
            verifiedSubjectToken: authenticationSubjectToken,
            verificationEvidence,
          },
          request,
          { fetch: fetchGitHub, now: () => testNow },
        ),
      ).resolves.toEqual({ ok: false, reason });

      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "installation_access_token_issuance_failed",
          subject_token: expect.objectContaining({
            issuer: "https://token.actions.githubusercontent.com",
            sub: "repo:fixture-owner/fixture-source-repository:ref:refs/heads/fixture-base-branch",
          }),
          token_issuance_policy: { outcome: reason },
          installation_access_token_request: {
            permissions: request.permissions,
            resource: request.resource.href,
            scope: request.scope,
          },
        }),
      );
      expect(fetchGitHub).not.toHaveBeenCalled();
      expectSafeIssuanceLog(consoleError.mock.calls);
    },
  );
});

interface IssuanceErrorLogOptions {
  readonly forbiddenValues?: readonly string[];
  readonly message: string;
  readonly status?: number;
  readonly targetInstallationId?: number;
  readonly upstreamStatus?: number;
}

function expectIssuanceErrorLog(logCalls: unknown, options: IssuanceErrorLogOptions): void {
  expect(logCalls).toContainEqual([
    expect.objectContaining({
      error: expect.objectContaining({
        message: options.message,
        status: options.status,
        upstream_status: options.upstreamStatus,
      }),
      event: "installation_access_token_issuance_failed",
      subject_token: expect.objectContaining({
        issuer: verifiedSubjectToken.issuer,
        resolved_key_id: verificationEvidence.resolvedKeyId,
        sub: verifiedSubjectToken.claims.sub,
        subject_token_kind: "id_token",
      }),
      target_installation: { id: options.targetInstallationId },
      token_issuance_policy: { outcome: "permitted" },
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
