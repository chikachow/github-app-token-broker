import { createOidcIdTokenAuthenticatorFactory } from "@github-app-token-broker/oidc/id-token-authenticator";
import {
  snapshotOidcProviderRegistrations,
  type OidcProviderRegistration,
} from "@github-app-token-broker/oidc/provider-registration";
import { problemResponse } from "@github-app-token-broker/http/problem-details";
import type { GitHubAppConfiguration } from "@github-app-token-broker/github/app";
import {
  snapshotGitHubAppMetadata,
  snapshotGitHubApps,
  type TokenExchangeGitHubApp,
  type TokenExchangeGitHubAppMetadata,
} from "./github-apps.ts";
export {
  snapshotGitHubAppMetadata,
  type TokenExchangeGitHubApp,
  type TokenExchangeGitHubAppMetadata,
} from "./github-apps.ts";
import {
  assertTokenIssuancePolicyIssuersAreRegistered,
  compileTokenIssuancePolicy,
  type TokenIssuancePolicy,
} from "@github-app-token-broker/token-issuance-policy";

import { createInstallationAccessTokenExchange } from "./installation-access-token-exchange.ts";
import {
  createTokenExchangeEndpoint,
  unexpectedTokenExchangeFailureResponse,
} from "./token-exchange.ts";

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

export interface GitHubAppTokenExchangeHandler extends TokenExchangeHandler {
  readonly tokenEndpointPaths: readonly string[];
}

export interface GitHubAppTokenExchangeFactory {
  readonly tokenEndpointPaths: readonly string[];
  bindPrivateKeys(credentials: readonly GitHubAppConfiguration[]): GitHubAppTokenExchangeHandler;
  bindPrivateKey(path: string, credential: GitHubAppConfiguration): TokenExchangeHandler;
}

export function createGitHubAppTokenExchange(
  configuration: GitHubAppTokenExchangeConfiguration,
  runtimeDependencies: TokenExchangeRuntimeDependencies = {
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
  },
): GitHubAppTokenExchangeHandler {
  const githubApps = snapshotGitHubApps(configuration.githubApps);
  return compileGitHubAppTokenExchange(
    { ...configuration, githubApps },
    runtimeDependencies,
  ).bindPrivateKeys(githubApps);
}

export function compileGitHubAppTokenExchange(
  configuration: {
    readonly composition: TokenExchangeComposition;
    readonly githubApps: readonly TokenExchangeGitHubAppMetadata[];
  },
  runtimeDependencies: TokenExchangeRuntimeDependencies = {
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
  },
): GitHubAppTokenExchangeFactory {
  const oidcProviderRegistrations = snapshotOidcProviderRegistrations(
    configuration.composition.oidcProviderRegistrations,
  );
  const tokenIssuancePolicy = compileTokenIssuancePolicy(
    configuration.composition.tokenIssuancePolicy.permitStatements,
  );
  assertTokenIssuancePolicyIssuersAreRegistered(tokenIssuancePolicy, oidcProviderRegistrations);
  const githubApps = snapshotGitHubAppMetadata(configuration.githubApps);
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
  const appsByPath = new Map(githubApps.map((app) => [`/github/apps/${app.slug}/token`, app]));
  const endpointFactories = new Map<
    string,
    (credentials: GitHubAppConfiguration) => TokenExchangeHandler
  >();
  for (const app of githubApps) {
    const policy = Object.freeze({
      permitStatements: Object.freeze(
        tokenIssuancePolicy.permitStatements.filter(
          (statement) => statement.githubAppClientId === app.clientId,
        ),
      ),
    });
    const authenticator = createAuthenticator(app.subjectTokenAudiences);
    endpointFactories.set(`/github/apps/${app.slug}/token`, (credentials) =>
      createTokenExchangeEndpoint({
        installationAccessTokenExchange: createInstallationAccessTokenExchange({
          githubApp: credentials,
          githubAppDependencies: dependencies,
          oidcIdTokenAuthenticator: authenticator,
          tokenIssuancePolicy: policy,
        }),
        now: dependencies.now,
      }),
    );
  }
  const tokenEndpointPaths = Object.freeze(Array.from(endpointFactories.keys()));
  function captureCredential(
    credential: GitHubAppConfiguration,
    expectedClientId?: string,
  ): GitHubAppConfiguration {
    if (typeof credential !== "object" || credential === null) {
      throw new TypeError("GitHub App credentials must select configured client IDs");
    }
    const clientId = credential.clientId;
    if (
      !appClientIds.has(clientId) ||
      (expectedClientId !== undefined && clientId !== expectedClientId)
    ) {
      throw new TypeError("GitHub App credentials must select configured client IDs");
    }
    return Object.freeze({ clientId, privateKey: credential.privateKey });
  }

  function dispatch(endpoints: ReadonlyMap<string, TokenExchangeHandler>): TokenExchangeHandler {
    return async (request: Request, context: TokenExchangeRequestContext) => {
      try {
        const endpoint = endpoints.get(new URL(request.url).pathname);
        return endpoint === undefined ? problemResponse(404) : await endpoint(request, context);
      } catch (error) {
        return unexpectedTokenExchangeFailureResponse(error);
      }
    };
  }

  return Object.freeze({
    tokenEndpointPaths,
    bindPrivateKey(path: string, credential: GitHubAppConfiguration) {
      const app = appsByPath.get(path);
      if (app === undefined) {
        throw new TypeError("GitHub App credentials must match the selected endpoint");
      }
      const captured = captureCredential(credential, app.clientId);
      return Object.freeze(dispatch(new Map([[path, endpointFactories.get(path)!(captured)]])));
    },
    bindPrivateKeys(credentials: readonly GitHubAppConfiguration[]) {
      if (!Array.isArray(credentials))
        throw new TypeError("GitHub App credentials must be an array");
      const captured = new Map<string, GitHubAppConfiguration>();
      for (const credential of credentials) {
        const snapshot = captureCredential(credential);
        if (captured.has(snapshot.clientId)) {
          throw new TypeError("GitHub App credentials must select unique configured client IDs");
        }
        captured.set(snapshot.clientId, snapshot);
      }
      if (captured.size !== githubApps.length)
        throw new TypeError("GitHub App credentials must cover the configured catalogue");
      const endpoints = new Map<string, TokenExchangeHandler>();
      for (const [path, app] of appsByPath) {
        endpoints.set(path, endpointFactories.get(path)!(captured.get(app.clientId)!));
      }
      const handler = dispatch(endpoints);
      return Object.freeze(Object.assign(handler, { tokenEndpointPaths }));
    },
  });
}
