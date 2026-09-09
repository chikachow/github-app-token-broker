import { describe, expect, it } from "vitest";

import { githubActionsOidcProviderRegistration } from "@github-app-token-broker/oidc-provider-github-actions";
import { createFlyOidcProviderRegistration } from "../packages/oidc-provider-fly/src/provider-registration.ts";
import { createInstallationAccessTokenRequest } from "@github-app-token-broker/github/installation-access-token-request";
import { createOidcIdTokenAuthenticator } from "@github-app-token-broker/oidc/id-token-authenticator";
import { parseSubjectTokenAudience } from "@github-app-token-broker/oidc/subject-token-audience";
import {
  claimEquals,
  compileTokenIssuancePolicy,
  githubRepositoryResourceConstraint,
  oidcSubjectTokenConstraint,
  evaluateTokenIssuancePolicy,
} from "@github-app-token-broker/token-issuance-policy";
import { fetchGitHubActionsOidcRemoteDocumentTestDouble } from "./support/github-actions-oidc.ts";
import { signRs256Jwt } from "./support/jwt.ts";
import { githubActionsIdTokenPayload } from "./support/github-actions.ts";
import { testNow } from "./support/constants.ts";
import { testPrivateKeyPem, testPublicJwk } from "./support/rsa-test-key-pair.ts";

describe("OIDC ID Token authentication configuration", () => {
  it("authenticates only the deployment-composed subject-token audience", async () => {
    const registration = githubActionsOidcProviderRegistration;
    const authenticator = createOidcIdTokenAuthenticator(
      {
        providerRegistrations: [registration],
        subjectTokenAudience: parseSubjectTokenAudience("https://broker.example"),
      },
      {
        fetch: fetchGitHubActionsOidcRemoteDocumentTestDouble,
        now: () => testNow,
      },
    );
    const acceptedToken = await signRs256Jwt(testPrivateKeyPem, githubActionsIdTokenPayload);
    const rejectedToken = await signRs256Jwt(testPrivateKeyPem, {
      ...githubActionsIdTokenPayload,
      aud: "different-audience",
    });

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
          subjectTokenAudience: parseSubjectTokenAudience("github-app-token-broker"),
        },
        {
          fetch: fetchGitHubActionsOidcRemoteDocumentTestDouble,
          now: () => testNow,
        },
      ),
    ).toThrow("duplicate OIDC Provider Registration issuer");
  });

  it("authenticates noncanonical Fly Claim relationships while policy selects material Claims", async () => {
    const registration = createFlyOidcProviderRegistration("example-org");
    const authenticator = createOidcIdTokenAuthenticator(
      {
        providerRegistrations: [registration],
        subjectTokenAudience: parseSubjectTokenAudience("github-app-token-broker"),
      },
      {
        fetch: async (input) => {
          const request = new Request(input);
          if (request.method !== "GET") return new Response(null, { status: 404 });
          if (request.url === "https://oidc.fly.io/example-org/.well-known/openid-configuration") {
            return Response.json({
              issuer: "https://oidc.fly.io/example-org",
              jwks_uri: "https://oidc.fly.io/example-org/.well-known/jwks",
              id_token_signing_alg_values_supported: ["RS256"],
            });
          }
          if (request.url === "https://oidc.fly.io/example-org/.well-known/jwks") {
            return Response.json({ keys: [testPublicJwk] });
          }
          return new Response(null, { status: 404 });
        },
        now: () => testNow,
      },
    );
    const token = await signRs256Jwt(testPrivateKeyPem, {
      iss: "https://oidc.fly.io/example-org",
      aud: "github-app-token-broker",
      iat: 1779580790,
      exp: 1779581100,
      app_name: "selected-app",
      machine_name: null,
      org_name: "different-org",
      sub: "custom-subject",
    });
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
    const request = createInstallationAccessTokenRequest({
      owner: "owner",
      permissions: { contents: "read" },
      repository: "repository",
    });

    expect(
      evaluateTokenIssuancePolicy(policy, authentication.verifiedSubjectToken, request),
    ).toEqual({ outcome: "permitted" });
    expect(
      evaluateTokenIssuancePolicy(
        policy,
        {
          ...authentication.verifiedSubjectToken,
          claims: { ...authentication.verifiedSubjectToken.claims, app_name: "other-app" },
        },
        request,
      ),
    ).toEqual({ outcome: "subject_token_unacceptable" });
  });
});
