import { describe, expect, it } from "vitest";

import { githubActionsOidcProviderRegistration } from "../src/provider-registration.ts";

describe("GitHub Actions OIDC Provider Registration", () => {
  const claims = {
    aud: "github-app-token-broker",
    exp: 2,
    iat: 1,
    iss: githubActionsOidcProviderRegistration.issuer,
    sub: "repo:fixture-owner/fixture-repository:ref:refs/heads/main",
  };

  it("registers the exact issuer and its provider-specific algorithm allowlist", () => {
    expect(githubActionsOidcProviderRegistration).toMatchObject({
      acceptedIdTokenSigningAlgorithms: ["RS256"],
      issuer: "https://token.actions.githubusercontent.com",
    });
    expect(githubActionsOidcProviderRegistration.idTokenProfile).not.toBeNull();
  });

  it("accepts an absent azp or an azp equal to the already-verified audience", () => {
    const { idTokenProfile } = githubActionsOidcProviderRegistration;

    if (idTokenProfile === null) {
      throw new Error("GitHub Actions registration requires an ID Token Profile");
    }

    expect(idTokenProfile.validate(claims)).toBe(true);
    expect(
      idTokenProfile.validate({
        ...claims,
        azp: "github-app-token-broker",
      }),
    ).toBe(true);
  });

  it("rejects a mismatched authorized party", () => {
    const { idTokenProfile } = githubActionsOidcProviderRegistration;

    if (idTokenProfile === null) {
      throw new Error("GitHub Actions registration requires an ID Token Profile");
    }

    expect(
      idTokenProfile.validate({
        ...claims,
        azp: "other-service",
      }),
    ).toBe(false);
  });
});
