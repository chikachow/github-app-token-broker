import {
  createInstallationAccessTokenExchange,
  type InstallationAccessTokenExchange,
} from "./installation-access-token-exchange.ts";
import { createOidcIdTokenAuthenticator } from "@github-app-token-broker/oidc/id-token-authenticator";
import { type TokenIssuancePolicy } from "@github-app-token-broker/token-issuance-policy";
import type { OidcIdTokenAuthenticatorDependencies } from "@github-app-token-broker/oidc/id-token-authenticator";
import type { OidcProviderRegistration } from "@github-app-token-broker/oidc/provider-registration";

interface TokenExchangeWorkerDependencies {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly oidcProviderRegistrations: readonly OidcProviderRegistration[];
  readonly tokenIssuancePolicy: TokenIssuancePolicy;
}

export const defaultTokenExchangeWorkerRuntimeDependencies = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  now: () => new Date(),
} satisfies Pick<TokenExchangeWorkerDependencies, "fetch" | "now">;

export function createInstallationAccessTokenExchangeForWorker(
  dependencies: TokenExchangeWorkerDependencies,
  subjectTokenAudience: string,
): InstallationAccessTokenExchange {
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
