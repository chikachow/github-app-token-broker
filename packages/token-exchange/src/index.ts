import type { GitHubAppConfiguration } from "@github-app-token-broker/github/app";
import { createOidcIdTokenAuthenticator } from "@github-app-token-broker/oidc/id-token-authenticator";
import {
  snapshotOidcProviderRegistrations,
  type OidcProviderRegistration,
} from "@github-app-token-broker/oidc/provider-registration";
import { parseSubjectTokenAudience } from "@github-app-token-broker/oidc/subject-token-audience";
import {
  assertTokenIssuancePolicyIssuersAreRegistered,
  type TokenIssuancePolicy,
} from "@github-app-token-broker/token-issuance-policy";

import { createInstallationAccessTokenExchange } from "./installation-access-token-exchange.ts";
import { createTokenExchangeEndpoint } from "./token-exchange.ts";

export type {
  ObserveOidcDiagnostic,
  ObserveTokenExchange,
  TokenExchangeObservation,
  TokenExchangeRequestContext,
} from "./events.ts";
import type { TokenExchangeRequestContext } from "./events.ts";
export {
  maxTokenExchangeBodyBytes,
  tokenExchangeInvalidRequestResponse,
} from "./token-exchange.ts";

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
  const oidcProviderRegistrations = snapshotOidcProviderRegistrations(
    configuration.composition.oidcProviderRegistrations,
  );
  const tokenIssuancePolicy = configuration.composition.tokenIssuancePolicy;
  assertTokenIssuancePolicyIssuersAreRegistered(tokenIssuancePolicy, oidcProviderRegistrations);
  const subjectTokenAudience = parseSubjectTokenAudience(configuration.subjectTokenAudience);
  const githubApp = Object.freeze({
    appId: configuration.githubApp.appId,
    privateKey: configuration.githubApp.privateKey,
  });
  const dependencies = Object.freeze({
    fetch: runtimeDependencies.fetch,
    now: runtimeDependencies.now,
  });
  const oidcIdTokenAuthenticator = createOidcIdTokenAuthenticator(
    { providerRegistrations: oidcProviderRegistrations, subjectTokenAudience },
    dependencies,
  );
  return createTokenExchangeEndpoint({
    installationAccessTokenExchange: createInstallationAccessTokenExchange({
      githubApp,
      githubAppDependencies: dependencies,
      oidcIdTokenAuthenticator,
      tokenIssuancePolicy,
    }),
    now: dependencies.now,
  });
}
