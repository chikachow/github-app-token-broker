import {
  createOidcProviderRegistration,
  type OidcIdTokenProfile,
} from "@github-app-token-broker/oidc/provider-registration";

const googleServiceAccountOidcIdTokenProfile: OidcIdTokenProfile = {
  validate: (claims) => claims["azp"] === claims.sub,
};

export const googleServiceAccountOidcProviderRegistration = createOidcProviderRegistration({
  acceptedIdTokenSigningAlgorithms: ["RS256"],
  idTokenProfile: googleServiceAccountOidcIdTokenProfile,
  issuer: "https://accounts.google.com",
});
