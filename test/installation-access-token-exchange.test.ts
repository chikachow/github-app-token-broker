import { describe, expect, it, vi } from "vitest";

import {
  createInstallationAccessTokenExchange,
  type InstallationAccessTokenExchangeCommand,
} from "../packages/token-exchange/src/installation-access-token-exchange.ts";
import type { AuthenticateSubjectToken } from "../packages/token-exchange/src/authentication.ts";
import { testNow, testRepository } from "./support/constants.ts";
import { fetchGitHubTestDouble } from "./support/github-api.ts";
import { mustNormalizeTokenRequest } from "./support/installation-access-token-request.ts";
import {
  testSubjectConstraintMatchingVerifiedSubjectToken,
  testTokenIssuancePolicy,
} from "./support/token-issuance-policy.ts";
import { testEnv } from "./support/worker-env.ts";

const command: InstallationAccessTokenExchangeCommand = {
  subjectToken: "serialized-subject-token",
  tokenRequest: mustNormalizeTokenRequest({
    resource: `https://api.github.com/repos/${testRepository}`,
    scope: "contents:write pull_requests:write",
  }),
};

describe("Installation Access Token Exchange application function", () => {
  it("authenticates the command before issuing a repository-scoped token", async () => {
    const observe = vi.fn();
    const context = {
      observe,
      request: { path: "/token", userAgent: "test-agent" },
    };
    const authenticateSubjectToken = vi.fn<AuthenticateSubjectToken>(async () => ({
      context: {
        verificationEvidence: { resolvedKeyId: "test-key-1" },
        verifiedSubjectToken: testSubjectConstraintMatchingVerifiedSubjectToken,
      },
      ok: true,
    }));
    const fetchExternal = vi.fn(fetchGitHubTestDouble);
    const exchangeInstallationAccessToken = createInstallationAccessTokenExchange(
      {
        githubApp: { appId: testEnv.GITHUB_APP_ID, privateKey: testEnv.GITHUB_APP_PRIVATE_KEY },
        tokenIssuancePolicy: testTokenIssuancePolicy,
      },
      {
        authenticateSubjectToken,
        githubAppDependencies: { fetch: fetchExternal, now: () => testNow },
      },
    );

    await expect(exchangeInstallationAccessToken(command, context)).resolves.toEqual({
      expiresAt: "2030-01-01T00:00:00Z",
      ok: true,
      token: "ghs_test_token",
    });
    expect(authenticateSubjectToken).toHaveBeenCalledWith(command.subjectToken, context);
    expect(fetchExternal).toHaveBeenCalledTimes(2);
  });

  it("returns an authentication failure without contacting GitHub", async () => {
    const authenticateSubjectToken = vi.fn<AuthenticateSubjectToken>(async () => ({
      ok: false,
      reason: "invalid_token",
    }));
    const fetchExternal = vi.fn<typeof fetch>();
    const exchangeInstallationAccessToken = createInstallationAccessTokenExchange(
      {
        githubApp: { appId: "unused", privateKey: "unused" },
        tokenIssuancePolicy: testTokenIssuancePolicy,
      },
      {
        authenticateSubjectToken,
        githubAppDependencies: { fetch: fetchExternal, now: () => testNow },
      },
    );

    await expect(
      exchangeInstallationAccessToken(command, {
        observe: vi.fn(),
        request: { path: "/token", userAgent: null },
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_token", stage: "authentication" });
    expect(fetchExternal).not.toHaveBeenCalled();
  });
});
