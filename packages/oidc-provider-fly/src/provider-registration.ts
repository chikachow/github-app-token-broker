import {
  createOidcProviderRegistration,
  parseOidcIssuerIdentifier,
  type OidcIssuerIdentifier,
  type OidcProviderRegistration,
} from "@github-app-token-broker/oidc/provider-registration";

const flyOidcIssuerPrefix = "https://oidc.fly.io/";
const flyOrganizationSlugPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

export function flyOidcIssuerIdentifierForOrganizationSlug(
  organizationSlug: string,
): OidcIssuerIdentifier | null {
  return flyOrganizationSlugPattern.test(organizationSlug)
    ? parseOidcIssuerIdentifier(`${flyOidcIssuerPrefix}${organizationSlug}`)
    : null;
}

export function createFlyOidcProviderRegistration(
  organizationSlug: string,
): OidcProviderRegistration {
  const issuer = flyOidcIssuerIdentifierForOrganizationSlug(organizationSlug);

  if (issuer === null) {
    throw new TypeError("unsupported Fly organization slug");
  }

  return createOidcProviderRegistration({
    acceptedIdTokenSigningAlgorithms: ["RS256"],
    idTokenProfile: null,
    issuer,
  });
}
