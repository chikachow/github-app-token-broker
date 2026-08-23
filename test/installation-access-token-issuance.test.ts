import { describe, expect, it, vi } from "vitest";
import type { VerifiedSubjectToken } from "@github-app-token-broker/oidc/id-token-authenticator";
import type { TokenExchangeObservation } from "../workers/github-app-token-broker/src/observability.ts";

import { issueInstallationAccessTokenForContext } from "../workers/github-app-token-broker/src/policy/installation-access-token-issuance.ts";
import { testInstallationId, testNow, testRepository } from "./support/constants.ts";
import { fetchGitHubTestDouble, githubInstallationResponse } from "./support/github-api.ts";
import { createVerifiedSubjectToken } from "./support/oidc.ts";
import { testTokenIssuancePolicy } from "./support/token-issuance-policy.ts";
import { testEnv } from "./support/worker-env.ts";
import { createInstallationAccessTokenRequest } from "@github-app-token-broker/github/installation-access-token-request";
import {
  compileTokenIssuancePolicy,
  githubRepositoryResourceConstraint,
  oidcSubjectTokenConstraint,
} from "@github-app-token-broker/token-issuance-policy";

const tokenRequest = createInstallationAccessTokenRequest({
  owner: "fixture-owner",
  permissions: { contents: "write", pull_requests: "write" },
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

describe("Installation Access Token Issuance", () => {
  it("awaits and propagates a rejected authorization-denial observation before GitHub I/O", async () => {
    const observerFailure = new Error("authorization observation failed");
    const fetchGitHub = vi.fn(fetchGitHubTestDouble);

    await expect(
      issueInstallationAccessTokenForContext({
        authenticationContext: { verifiedSubjectToken, verificationEvidence },
        dependencies: { fetch: fetchGitHub, now: () => testNow },
        githubApp: testEnv,
        installationAccessTokenRequest: createInstallationAccessTokenRequest({
          owner: "other-owner",
          permissions: tokenRequest.permissions,
          repository: tokenRequest.resource.repository,
        }),
        observe: async () => {
          throw observerFailure;
        },
        tokenIssuancePolicy: testTokenIssuancePolicy,
      }),
    ).rejects.toBe(observerFailure);
    expect(fetchGitHub).not.toHaveBeenCalled();
  });

  it("awaits and propagates a rejected GitHub-issuance-failure observation", async () => {
    const observerFailure = new Error("issuance observation failed");
    const observedEvents: unknown[] = [];
    const fetchGitHub = vi.fn(async () => new Response(null, { status: 404 }));

    await expect(
      issueInstallationAccessTokenForContext({
        authenticationContext: { verifiedSubjectToken, verificationEvidence },
        dependencies: { fetch: fetchGitHub, now: () => testNow },
        githubApp: testEnv,
        installationAccessTokenRequest: tokenRequest,
        observe: async (observation) => {
          const event = observation.fields["event"];
          observedEvents.push(event);

          if (event === "installation_access_token_issuance_failed") {
            throw observerFailure;
          }
        },
        tokenIssuancePolicy: testTokenIssuancePolicy,
      }),
    ).rejects.toBe(observerFailure);
    expect(fetchGitHub).toHaveBeenCalledOnce();
    expect(observedEvents).toEqual([
      "installation_access_token_issuance_started",
      "installation_access_token_issuance_failed",
    ]);
  });

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
    ).resolves.toMatchObject({ ok: true });

    expect(requestedPaths).not.toContain(`/repos/${testRepository}`);
  });

  it("does not mint when installation resolution returns a different owner", async () => {
    const observations: TokenExchangeObservation[] = [];
    const requestedRequests: Array<{ method: string; path: string }> = [];

    await expect(
      issueInstallationAccessToken(
        {
          fetch: async (input, init) => {
            const request = new Request(input, init);
            const url = new URL(request.url);
            requestedRequests.push({ method: request.method, path: url.pathname });

            return request.method === "GET"
              ? githubInstallationResponse("transferred-owner", testInstallationId)
              : new Response(null, { status: 500 });
          },
        },
        observations,
      ),
    ).resolves.toEqual({ ok: false, reason: "upstream_failure" });

    expect(requestedRequests).toEqual([
      { method: "GET", path: `/repos/${testRepository}/installation` },
    ]);
    expectIssuanceErrorLog(observations, {
      message: `GitHub API returned an invalid response: /repos/${testRepository}/installation`,
      status: 502,
      upstreamStatus: 200,
    });
  });

  it("forwards arbitrary requested permissions exactly to GitHub", async () => {
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
      issueInstallationAccessTokenForContext({
        authenticationContext: { verifiedSubjectToken, verificationEvidence },
        dependencies: {
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
        githubApp: testEnv,
        installationAccessTokenRequest: createInstallationAccessTokenRequest({
          owner: tokenRequest.resource.owner,
          permissions: requestedPermissions,
          repository: tokenRequest.resource.repository,
        }),
        observe: async () => undefined,
        tokenIssuancePolicy: policy,
      }),
    ).resolves.toMatchObject({ ok: true, token: "ghs_arbitrary_permissions" });

    expect(forwardedBody).toEqual({
      permissions: requestedPermissions,
      repositories: [tokenRequest.resource.repository],
    });
  });

  it("records the permissions granted by GitHub, not the requested permissions", async () => {
    const observations: TokenExchangeObservation[] = [];
    const grantedPermissions = { contents: "read" };

    await expect(
      issueInstallationAccessToken(
        {
          fetch: async (input, init) => {
            const request = new Request(input, init);
            if (request.method === "POST") {
              return Response.json(
                {
                  expires_at: "2030-01-01T00:00:00Z",
                  permissions: grantedPermissions,
                  token: "ghs_test_token",
                },
                { status: 201 },
              );
            }
            return fetchGitHubTestDouble(input, init);
          },
        },
        observations,
      ),
    ).resolves.toMatchObject({ ok: true, token: "ghs_test_token" });

    expect(observations).toEqual([
      {
        fields: {
          event: "installation_access_token_issuance_started",
          installation_access_token_request: {
            permissions: tokenRequest.permissions,
            resource: tokenRequest.resource.href,
            scope: tokenRequest.scope,
          },
          subject_token: {
            issuer: verifiedSubjectToken.issuer,
            resolved_key_id: verificationEvidence.resolvedKeyId,
            sub: verifiedSubjectToken.claims.sub,
            subject_token_kind: "id_token",
          },
          target_installation: { id: undefined, repository: testRepository },
          token_issuance_policy: { outcome: "permitted" },
        },
        level: "info",
      },
      {
        fields: {
          event: "installation_access_token_issuance_succeeded",
          expires_at: "2030-01-01T00:00:00Z",
          installation_access_token: { permissions: grantedPermissions },
          installation_access_token_request: {
            permissions: tokenRequest.permissions,
            resource: tokenRequest.resource.href,
            scope: tokenRequest.scope,
          },
          subject_token: {
            issuer: verifiedSubjectToken.issuer,
            resolved_key_id: verificationEvidence.resolvedKeyId,
            sub: verifiedSubjectToken.claims.sub,
            subject_token_kind: "id_token",
          },
          target_installation: { id: testInstallationId, repository: testRepository },
          token_issuance_policy: { outcome: "permitted" },
        },
        level: "info",
      },
    ]);
    expectSafeIssuanceLog(observations, "ghs_test_token");
  });

  it.each([
    { reason: "internal_failure", status: 400 },
    { reason: "internal_failure", status: 401 },
    { reason: "internal_failure", status: 422 },
    { reason: "upstream_failure", status: 403 },
    { reason: "upstream_failure", status: 404 },
    { reason: "upstream_unavailable", status: 429 },
    { reason: "upstream_failure", status: 500 },
    { reason: "upstream_unavailable", status: 503 },
  ] as const)(
    "maps installation resolution status $status to $reason",
    async ({ reason, status }) => {
      const observations: TokenExchangeObservation[] = [];
      const fetchGitHub = vi.fn(async () => new Response(null, { status }));

      await expect(
        issueInstallationAccessToken({ fetch: fetchGitHub }, observations),
      ).resolves.toEqual({
        ok: false,
        reason,
      });

      expect(fetchGitHub).toHaveBeenCalledOnce();
      expectIssuanceErrorLog(observations, {
        message: `GitHub API request failed: /repos/${testRepository}/installation`,
        status,
        upstreamStatus: status,
      });
    },
  );

  it("maps a GitHub transport failure to upstream unavailable without exposing its detail", async () => {
    const observations: TokenExchangeObservation[] = [];
    const privateFailure = "private network failure details";

    await expect(
      issueInstallationAccessToken(
        {
          fetch: async () => {
            throw new Error(privateFailure);
          },
        },
        observations,
      ),
    ).resolves.toEqual({ ok: false, reason: "upstream_unavailable" });

    expectIssuanceErrorLog(observations, {
      forbiddenValues: [privateFailure],
      message: `GitHub API request failed: /repos/${testRepository}/installation`,
    });
  });

  it.each([
    { privateKey: "", scenario: "missing" },
    { privateKey: "not a private key", scenario: "invalid" },
  ])("maps a $scenario GitHub App private key to an internal failure", async ({ privateKey }) => {
    const observations: TokenExchangeObservation[] = [];
    const fetchGitHub = vi.fn(fetchGitHubTestDouble);

    await expect(
      issueInstallationAccessTokenForContext({
        authenticationContext: { verifiedSubjectToken, verificationEvidence },
        dependencies: { fetch: fetchGitHub, now: () => testNow },
        githubApp: { ...testEnv, GITHUB_APP_PRIVATE_KEY: privateKey },
        installationAccessTokenRequest: tokenRequest,
        observe: async (observation) => {
          observations.push(observation);
        },
        tokenIssuancePolicy: testTokenIssuancePolicy,
      }),
    ).resolves.toEqual({ ok: false, reason: "internal_failure" });

    expect(fetchGitHub).not.toHaveBeenCalled();
    expectIssuanceErrorLog(observations, {
      forbiddenValues: privateKey.length > 0 ? [privateKey] : [],
      message: "invalid GitHub App configuration",
    });
  });

  it.each([
    { headers: undefined, reason: "upstream_failure", status: 404 },
    { headers: undefined, reason: "upstream_unavailable", status: 503 },
    { headers: { "x-ratelimit-remaining": "0" }, reason: "upstream_unavailable", status: 403 },
  ] as const)(
    "records the resolved installation when minting returns $status",
    async ({ headers, reason, status }) => {
      const observations: TokenExchangeObservation[] = [];
      const methods: string[] = [];

      await expect(
        issueInstallationAccessToken(
          {
            fetch: async (input, init) => {
              const request = new Request(input, init);
              methods.push(request.method);
              return request.method === "GET"
                ? githubInstallationResponse("fixture-owner", testInstallationId)
                : new Response(null, { ...(headers === undefined ? {} : { headers }), status });
            },
          },
          observations,
        ),
      ).resolves.toEqual({ ok: false, reason });

      expect(methods).toEqual(["GET", "POST"]);
      expectIssuanceErrorLog(observations, {
        message: `GitHub API request failed: /app/installations/${testInstallationId}/access_tokens`,
        status,
        targetInstallationId: testInstallationId,
        upstreamStatus: status,
      });
    },
  );

  it("retains the resolved installation when token minting has a transport failure", async () => {
    const observations: TokenExchangeObservation[] = [];
    const privateFailure = "private token-mint transport failure";

    await expect(
      issueInstallationAccessToken(
        {
          fetch: async (input, init) => {
            const request = new Request(input, init);
            if (request.method === "GET") {
              return githubInstallationResponse("fixture-owner", testInstallationId);
            }
            throw new Error(privateFailure);
          },
        },
        observations,
      ),
    ).resolves.toEqual({ ok: false, reason: "upstream_unavailable" });

    expectIssuanceErrorLog(observations, {
      forbiddenValues: [privateFailure],
      message: `GitHub API request failed: /app/installations/${testInstallationId}/access_tokens`,
      targetInstallationId: testInstallationId,
    });
  });

  it("maps an unexpected credential-binding failure to a sanitized internal failure", async () => {
    const observations: TokenExchangeObservation[] = [];
    const privateFailure = "private credential provider failure details";
    const privateErrorName = "PrivateCredentialProviderFailure";
    const credentialError = new Error(privateFailure);
    credentialError.name = privateErrorName;
    const fetchGitHub = vi.fn<typeof fetch>();

    await expect(
      issueInstallationAccessTokenForContext({
        authenticationContext: { verifiedSubjectToken, verificationEvidence },
        dependencies: { fetch: fetchGitHub, now: () => testNow },
        githubApp: {
          ...testEnv,
          GITHUB_APP_PRIVATE_KEY: {
            get: async () => Promise.reject(credentialError),
          },
        },
        installationAccessTokenRequest: tokenRequest,
        observe: async (observation) => {
          observations.push(observation);
        },
        tokenIssuancePolicy: testTokenIssuancePolicy,
      }),
    ).resolves.toEqual({ ok: false, reason: "internal_failure" });

    expect(fetchGitHub).not.toHaveBeenCalled();
    expectIssuanceErrorLog(observations, {
      forbiddenValues: [privateFailure, privateErrorName],
      message: "unexpected Installation Access Token Issuance error",
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
    "returns and records policy outcome $reason without calling GitHub",
    async ({ authenticationSubjectToken, reason, request }) => {
      const observations: TokenExchangeObservation[] = [];
      const fetchGitHub = vi.fn(fetchGitHubTestDouble);

      await expect(
        issueInstallationAccessTokenForContext({
          authenticationContext: {
            verifiedSubjectToken: authenticationSubjectToken,
            verificationEvidence,
          },
          dependencies: { fetch: fetchGitHub, now: () => testNow },
          githubApp: testEnv,
          installationAccessTokenRequest: request,
          observe: async (observation) => {
            observations.push(observation);
          },
          tokenIssuancePolicy: testTokenIssuancePolicy,
        }),
      ).resolves.toEqual({ ok: false, reason });

      expect(fetchGitHub).not.toHaveBeenCalled();
      expect(observations).toContainEqual({
        fields: expect.objectContaining({ token_issuance_policy: { outcome: reason } }),
        level: "error",
      });
      expectSafeIssuanceLog(observations);
    },
  );
});

function issueInstallationAccessToken(
  dependencies: { fetch: typeof fetch },
  observations: TokenExchangeObservation[] = [],
) {
  return issueInstallationAccessTokenForContext({
    authenticationContext: { verifiedSubjectToken, verificationEvidence },
    dependencies: { ...dependencies, now: () => testNow },
    githubApp: testEnv,
    installationAccessTokenRequest: tokenRequest,
    observe: async (observation) => {
      observations.push(observation);
    },
    tokenIssuancePolicy: testTokenIssuancePolicy,
  });
}

interface IssuanceErrorLogOptions {
  readonly forbiddenValues?: readonly string[];
  readonly message: string;
  readonly status?: number;
  readonly targetInstallationId?: number;
  readonly upstreamStatus?: number;
}

function expectIssuanceErrorLog(
  observations: readonly TokenExchangeObservation[],
  options: IssuanceErrorLogOptions,
): void {
  expect(observations).toContainEqual({
    fields: expect.objectContaining({
      error: expect.objectContaining({
        message: options.message,
        status: options.status,
        upstream_status: options.upstreamStatus,
      }),
      event: "installation_access_token_issuance_failed",
      target_installation: { id: options.targetInstallationId },
      token_issuance_policy: { outcome: "permitted" },
    }),
    level: "error",
  });
  expectSafeIssuanceLog(observations, ...(options.forbiddenValues ?? []));
}

function expectSafeIssuanceLog(
  observations: readonly TokenExchangeObservation[],
  ...forbiddenValues: readonly string[]
): void {
  const serialized = JSON.stringify(observations);
  expect(serialized).not.toMatch(/rule_id|deny_reasons|matched|"claims"/u);
  expect(serialized).not.toContain(testEnv.GITHUB_APP_ID);
  expect(serialized).not.toContain(testEnv.GITHUB_APP_PRIVATE_KEY);
  for (const forbiddenValue of forbiddenValues) {
    expect(serialized).not.toContain(forbiddenValue);
  }
}
