import { describe, expect, it } from "vitest";

import {
  createFlyOidcProviderRegistration,
  flyOidcIssuerIdentifierForOrganizationSlug,
} from "../dist/provider-registration.js";

describe("Fly OIDC Provider Registration", () => {
  it.each(["a", "example-org", "example--org"])(
    "constructs an issuer from a canonical organization slug: %s",
    (organizationSlug) => {
      expect(flyOidcIssuerIdentifierForOrganizationSlug(organizationSlug)).toBe(
        `https://oidc.fly.io/${organizationSlug}`,
      );
      expect(createFlyOidcProviderRegistration(organizationSlug)).toMatchObject({
        acceptedIdTokenSigningAlgorithms: ["RS256"],
        idTokenProfile: null,
        issuer: `https://oidc.fly.io/${organizationSlug}`,
      });
    },
  );

  it.each([
    "",
    "-",
    "-example",
    "example-",
    "Example-Org",
    "example_org",
    "example/org",
    " example-org ",
  ])("rejects a noncanonical organization slug: %j", (organizationSlug) => {
    expect(flyOidcIssuerIdentifierForOrganizationSlug(organizationSlug)).toBeNull();
    expect(() => createFlyOidcProviderRegistration(organizationSlug)).toThrow(
      new TypeError("unsupported Fly organization slug"),
    );
  });
});
