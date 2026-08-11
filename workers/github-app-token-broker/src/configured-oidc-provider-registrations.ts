import { githubActionsOidcProviderRegistration } from "@github-app-token-broker/oidc-provider-github-actions";
import { googleServiceAccountOidcProviderRegistration } from "@github-app-token-broker/oidc-provider-google-service-account";

export { githubActionsOidcProviderRegistration, googleServiceAccountOidcProviderRegistration };

export const configuredOidcProviderRegistrations = Object.freeze([
  githubActionsOidcProviderRegistration,
  googleServiceAccountOidcProviderRegistration,
]);
