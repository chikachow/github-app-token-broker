import { createOidcProviderRegistration } from "@github-app-token-broker/oidc/provider-registration";

export const buildkiteOidcProviderRegistration = createOidcProviderRegistration({
  acceptedIdTokenSigningAlgorithms: ["RS256"],
  idTokenProfile: null,
  issuer: "https://agent.buildkite.com",
});
