import {
  createOidcProviderRegistration,
  type OidcIdTokenProfile,
} from "@github-app-token-broker/oidc/provider-registration";

const githubActionsOidcIdTokenProfile: OidcIdTokenProfile = {
  validate: (claims) => claims["azp"] === undefined || claims["azp"] === claims.aud,
};

export const githubActionsOidcProviderRegistration = createOidcProviderRegistration({
  acceptedIdTokenSigningAlgorithms: ["RS256"],
  idTokenProfile: githubActionsOidcIdTokenProfile,
  issuer: "https://token.actions.githubusercontent.com",
});
