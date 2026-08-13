import { createOidcIdTokenAuthenticator } from "@github-app-token-broker/oidc/id-token-authenticator";
import {
  snapshotOidcProviderRegistrations,
  type OidcProviderRegistration,
} from "@github-app-token-broker/oidc/provider-registration";
import {
  assertTokenIssuancePolicyIssuersAreRegistered,
  type TokenIssuancePolicy,
} from "@github-app-token-broker/token-issuance-policy";
import type { GitHubAppConfiguration } from "@github-app-token-broker/github/app";

import { createInstallationAccessTokenExchange } from "./installation-access-token-exchange.ts";
import { createAuthenticateSubjectToken } from "./authentication.ts";
import { parseSubjectTokenAudience } from "./subject-token-audience.ts";
import { createTokenExchangeEndpoint } from "./token-exchange.ts";
import type { TokenExchangeRequestContext } from "./events.ts";

export type { TokenExchangeEvent, TokenExchangeRequestContext } from "./events.ts";
export { oauthErrorResponse } from "./token-exchange.ts";

export function snapshotTokenExchangeComposition(
  composition: TokenExchangeComposition,
): TokenExchangeComposition {
  const oidcProviderRegistrations = snapshotOidcProviderRegistrations(
    composition.oidcProviderRegistrations,
  );
  const tokenIssuancePolicy = composition.tokenIssuancePolicy;
  assertTokenIssuancePolicyIssuersAreRegistered(tokenIssuancePolicy, oidcProviderRegistrations);

  return Object.freeze({ oidcProviderRegistrations, tokenIssuancePolicy });
}

export interface TokenExchangeComposition {
  readonly oidcProviderRegistrations: readonly OidcProviderRegistration[];
  readonly tokenIssuancePolicy: TokenIssuancePolicy;
}

export interface GitHubAppTokenExchangeConfiguration {
  readonly composition: TokenExchangeComposition;
  readonly githubApp: GitHubAppConfiguration;
  readonly subjectTokenAudience: string;
}

export interface TokenExchangeRuntimeDependencies {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
}

export type TokenExchangeHandler = (
  request: Request,
  context: TokenExchangeRequestContext,
) => Promise<Response>;

export function createGitHubAppTokenExchange(
  configuration: GitHubAppTokenExchangeConfiguration,
  runtimeDependencies: TokenExchangeRuntimeDependencies = {
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
  },
): TokenExchangeHandler {
  const subjectTokenAudience = parseSubjectTokenAudience(configuration.subjectTokenAudience);
  const composition = snapshotTokenExchangeComposition(configuration.composition);
  const githubApp = Object.freeze({
    ...(configuration.githubApp.apiBaseUrl === undefined
      ? {}
      : { apiBaseUrl: configuration.githubApp.apiBaseUrl }),
    appId: configuration.githubApp.appId,
    privateKey: configuration.githubApp.privateKey,
  });
  const dependencies = Object.freeze({
    fetch: runtimeDependencies.fetch,
    now: runtimeDependencies.now,
  });
  const oidcIdTokenAuthenticator = createOidcIdTokenAuthenticator(
    { providerRegistrations: composition.oidcProviderRegistrations, subjectTokenAudience },
    dependencies,
  );
  const authenticateSubjectToken = createAuthenticateSubjectToken(oidcIdTokenAuthenticator);
  const exchangeInstallationAccessToken = createInstallationAccessTokenExchange(
    { githubApp, tokenIssuancePolicy: composition.tokenIssuancePolicy },
    { authenticateSubjectToken, githubAppDependencies: dependencies },
  );

  return createTokenExchangeEndpoint(exchangeInstallationAccessToken, dependencies.now);
}
