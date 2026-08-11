import { configuredOidcProviderRegistrations } from "./configured-oidc-provider-registrations.ts";
import { configuredTokenIssuancePolicy } from "./policy/configured-token-issuance-policy.ts";

export const configuredTokenExchangeComposition = Object.freeze({
  oidcProviderRegistrations: configuredOidcProviderRegistrations,
  tokenIssuancePolicy: configuredTokenIssuancePolicy,
});
