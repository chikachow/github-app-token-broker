import { createOidcProviderRegistration } from "../oidc/provider-registration.ts";

export const buildkiteOidcProviderRegistration = createOidcProviderRegistration({
  acceptedIdTokenSigningAlgorithms: ["RS256"],
  idTokenProfile: null,
  issuer: "https://agent.buildkite.com",
});
