import { describe, expect, it } from "vitest";

import { githubActionsOidcProviderRegistration } from "@github-app-token-broker/oidc-provider-github-actions";
import { createFlyOidcProviderRegistration } from "../packages/oidc-provider-fly/src/provider-registration.ts";
import {
  createGitHubRepositoryResource,
  type InstallationAccessTokenRequest,
} from "@github-app-token-broker/github/installation-access-token-request";
import { createOidcIdTokenAuthenticator } from "@github-app-token-broker/oidc/id-token-authenticator";
import {
  claimEquals,
  compileTokenIssuancePolicy,
  githubRepositoryResourceConstraint,
  oidcSubjectTokenConstraint,
  tokenIssuancePolicyPermits,
} from "@github-app-token-broker/token-issuance-policy";
import { fetchOidcRemoteDocumentResponseTestDouble } from "./support/oidc.ts";
import { createOidcToken } from "./support/oidc-token.ts";
import { testPrivateKeyPem } from "./support/rsa-test-key-pair.ts";

describe("OIDC ID Token authentication configuration", () => {
  it("authenticates only the deployment-composed subject-token audience", async () => {
    const registration = githubActionsOidcProviderRegistration;
    const authenticator = createOidcIdTokenAuthenticator(
      {
        providerRegistrations: [registration],
        subjectTokenAudience: "https://broker.example",
      },
      {
        fetch: fetchOidcRemoteDocumentResponseTestDouble,
        now: () => new Date(),
      },
    );
    const acceptedToken = await createOidcToken(
      testPrivateKeyPem,
      {},
      { audience: "https://broker.example", issuer: registration.issuer },
    );
    const rejectedToken = await createOidcToken(
      testPrivateKeyPem,
      {},
      { audience: "different-audience", issuer: registration.issuer },
    );

    await expect(authenticator.authenticateIdToken(acceptedToken)).resolves.toMatchObject({
      ok: true,
    });
    await expect(authenticator.authenticateIdToken(rejectedToken)).resolves.toMatchObject({
      failure: { kind: "subject_token_rejected" },
      ok: false,
    });
  });

  it("rejects duplicate explicitly supplied issuer registrations", () => {
    const registration = githubActionsOidcProviderRegistration;

    expect(() =>
      createOidcIdTokenAuthenticator(
        {
          providerRegistrations: [registration, registration],
          subjectTokenAudience: "github-app-token-broker",
        },
        {
          fetch: fetchOidcRemoteDocumentResponseTestDouble,
          now: () => new Date(),
        },
      ),
    ).toThrow("duplicate OIDC Provider Registration issuer");
  });

  it("authenticates noncanonical Fly Claim relationships while policy selects material Claims", async () => {
    const registration = createFlyOidcProviderRegistration("example-org");
    const authenticator = createOidcIdTokenAuthenticator(
      {
        providerRegistrations: [registration],
        subjectTokenAudience: "github-app-token-broker",
      },
      {
        fetch: fetchOidcRemoteDocumentResponseTestDouble,
        now: () => new Date(),
      },
    );
    const token = await createOidcToken(
      testPrivateKeyPem,
      {
        app_name: "selected-app",
        machine_name: null,
        org_name: "different-org",
        sub: "custom-subject",
      },
      { audience: "github-app-token-broker", issuer: registration.issuer },
    );
    const authentication = await authenticator.authenticateIdToken(token);

    expect(authentication.ok).toBe(true);

    if (!authentication.ok) {
      throw new Error("expected Fly token authentication to succeed");
    }

    const policy = compileTokenIssuancePolicy([
      {
        permissions: { contents: "read" },
        resource: githubRepositoryResourceConstraint("owner", "repository"),
        subjectToken: oidcSubjectTokenConstraint(
          registration.issuer,
          claimEquals("app_name", "selected-app"),
        ),
      },
    ]);
    const request: InstallationAccessTokenRequest = {
      permissions: { contents: "read" },
      resource: createGitHubRepositoryResource({ owner: "owner", repository: "repository" }),
      scope: "contents:read",
    };

    expect(tokenIssuancePolicyPermits(policy, authentication.verifiedSubjectToken, request)).toBe(
      true,
    );
    expect(
      tokenIssuancePolicyPermits(
        policy,
        {
          ...authentication.verifiedSubjectToken,
          claims: { ...authentication.verifiedSubjectToken.claims, app_name: "other-app" },
        },
        request,
      ),
    ).toBe(false);
  });
});
