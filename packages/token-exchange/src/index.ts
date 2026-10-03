import { createOidcIdTokenAuthenticatorFactory } from "@github-app-token-broker/oidc/id-token-authenticator";
import {
  snapshotOidcProviderRegistrations,
  type OidcProviderRegistration,
} from "@github-app-token-broker/oidc/provider-registration";
import { problemResponse } from "@github-app-token-broker/http/problem-details";
import { snapshotGitHubApps, type TokenExchangeGitHubApp } from "./github-apps.ts";
export { snapshotGitHubApps, type TokenExchangeGitHubApp } from "./github-apps.ts";
import {
  assertTokenIssuancePolicyIssuersAreRegistered,
  compileTokenIssuancePolicy,
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
  readonly githubApps: readonly TokenExchangeGitHubApp[];
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
  const tokenIssuancePolicy = compileTokenIssuancePolicy(
    configuration.composition.tokenIssuancePolicy.permitStatements,
  );
  assertTokenIssuancePolicyIssuersAreRegistered(tokenIssuancePolicy, oidcProviderRegistrations);
  const githubApps = snapshotGitHubApps(configuration.githubApps);
  const appClientIds = new Set(githubApps.map((app) => app.clientId));
  for (const statement of tokenIssuancePolicy.permitStatements) {
    if (!appClientIds.has(statement.githubAppClientId)) {
      throw new TypeError("Token Issuance Policy references an unconfigured GitHub App");
    }
  }
  const dependencies = Object.freeze({
    fetch: runtimeDependencies.fetch,
    now: runtimeDependencies.now,
  });
  const createAuthenticator = createOidcIdTokenAuthenticatorFactory(
    oidcProviderRegistrations,
    dependencies,
  );
  const endpoints = new Map<string, TokenExchangeHandler>();
  for (const app of githubApps) {
    const policy = Object.freeze({
      permitStatements: Object.freeze(
        tokenIssuancePolicy.permitStatements.filter(
          (statement) => statement.githubAppClientId === app.clientId,
        ),
      ),
    });
    endpoints.set(
      `/github/apps/${app.slug}/token`,
      createTokenExchangeEndpoint({
        installationAccessTokenExchange: createInstallationAccessTokenExchange({
          githubApp: app,
          githubAppDependencies: dependencies,
          oidcIdTokenAuthenticator: createAuthenticator(app.subjectTokenAudiences),
          tokenIssuancePolicy: policy,
        }),
        now: dependencies.now,
      }),
    );
  }
  return async (request, context) => {
    const endpoint = endpoints.get(new URL(request.url).pathname);
    return endpoint === undefined ? problemResponse(404) : endpoint(request, context);
  };
}
