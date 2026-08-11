import {
  createInstallationAccessTokenExchange,
  type InstallationAccessTokenExchange,
} from "./installation-access-token-exchange.ts";
import { createOidcIdTokenAuthenticator } from "@github-app-token-broker/oidc/id-token-authenticator";
import {
  assertTokenIssuancePolicyIssuersAreRegistered,
  type TokenIssuancePolicy,
} from "./policy/token-issuance-policy.ts";
import { configuredTokenExchangeComposition } from "./configured-token-exchange-composition.ts";
import type { OidcIdTokenAuthenticatorDependencies } from "@github-app-token-broker/oidc/id-token-authenticator";
import type { OidcProviderRegistration } from "@github-app-token-broker/oidc/provider-registration";

export interface TokenExchangeWorkerDependencies {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly oidcProviderRegistrations: readonly OidcProviderRegistration[];
  readonly tokenIssuancePolicy: TokenIssuancePolicy;
}

export interface TokenExchangeWorkerRuntimeDependencies {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
}

export const defaultTokenExchangeWorkerRuntimeDependencies: TokenExchangeWorkerRuntimeDependencies =
  {
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
  };

export function configuredTokenExchangeWorkerDependencies(
  runtimeDependencies: TokenExchangeWorkerRuntimeDependencies,
): TokenExchangeWorkerDependencies {
  return { ...runtimeDependencies, ...configuredTokenExchangeComposition };
}

export function createInstallationAccessTokenExchangeForWorker(
  dependencies: TokenExchangeWorkerDependencies,
  subjectTokenAudience: string,
): InstallationAccessTokenExchange {
  assertTokenIssuancePolicyIssuersAreRegistered(
    dependencies.tokenIssuancePolicy,
    dependencies.oidcProviderRegistrations,
  );

  const oidcIdTokenAuthenticatorDependencies: OidcIdTokenAuthenticatorDependencies = {
    fetch: (input, init) => dependencies.fetch(input, init),
    now: () => dependencies.now(),
    observe: (event) => console.warn(event),
  };
  const oidcIdTokenAuthenticator = createOidcIdTokenAuthenticator(
    {
      providerRegistrations: dependencies.oidcProviderRegistrations,
      subjectTokenAudience,
    },
    oidcIdTokenAuthenticatorDependencies,
  );

  return createInstallationAccessTokenExchange({
    githubAppDependencies: dependencies,
    oidcIdTokenAuthenticator,
    tokenIssuancePolicy: dependencies.tokenIssuancePolicy,
  });
}
