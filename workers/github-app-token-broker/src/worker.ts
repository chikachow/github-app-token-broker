import { problemResponse } from "@github-app-token-broker/http/problem-details";
import { createOidcIdTokenAuthenticator } from "@github-app-token-broker/oidc/id-token-authenticator";
import {
  parseSubjectTokenAudience,
  type SubjectTokenAudience,
} from "@github-app-token-broker/oidc/subject-token-audience";
import type { GitHubAppEnv } from "@github-app-token-broker/github/app";
import type { InstallationAccessTokenExchange } from "./installation-access-token-exchange.ts";
import { createInstallationAccessTokenExchange } from "./installation-access-token-exchange.ts";
import {
  handleTokenExchangeRequest,
  tokenExchangeMethodNotAllowedResponse,
} from "./token-exchange.ts";
import {
  assertTokenIssuancePolicyIssuersAreRegistered,
  type TokenIssuancePolicy,
} from "@github-app-token-broker/token-issuance-policy";
import {
  snapshotOidcProviderRegistrations,
  type OidcProviderRegistration,
} from "@github-app-token-broker/oidc/provider-registration";

export interface TokenExchangeComposition {
  readonly oidcProviderRegistrations: readonly OidcProviderRegistration[];
  readonly tokenIssuancePolicy: TokenIssuancePolicy;
}

export interface TokenExchangeWorkerRuntimeDependencies {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
}

export interface TokenExchangeWorkerEnv extends GitHubAppEnv {
  readonly TOKEN_BROKER_AUDIENCE: string;
  readonly TOKEN_EXCHANGE_RATE_LIMIT: {
    limit(options: { readonly key: string }): Promise<{ readonly success: boolean }>;
  };
}

export function createTokenExchangeWorker(
  composition: TokenExchangeComposition,
  runtimeDependencies: TokenExchangeWorkerRuntimeDependencies = {
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
  },
): ExportedHandler<TokenExchangeWorkerEnv> {
  const oidcProviderRegistrations = snapshotOidcProviderRegistrations(
    composition.oidcProviderRegistrations,
  );
  const tokenIssuancePolicy = composition.tokenIssuancePolicy;
  assertTokenIssuancePolicyIssuersAreRegistered(tokenIssuancePolicy, oidcProviderRegistrations);
  const workerDependencies = Object.freeze({
    fetch: runtimeDependencies.fetch,
    now: runtimeDependencies.now,
    oidcProviderRegistrations,
    tokenIssuancePolicy,
  });
  let configuredRuntime:
    | {
        readonly audience: SubjectTokenAudience;
        readonly tokenExchange: InstallationAccessTokenExchange;
      }
    | undefined;

  return {
    fetch(request, env) {
      const audience = parseSubjectTokenAudience(env.TOKEN_BROKER_AUDIENCE);
      configuredRuntime ??= {
        audience,
        tokenExchange: createInstallationAccessTokenExchange({
          githubAppDependencies: workerDependencies,
          oidcIdTokenAuthenticator: createOidcIdTokenAuthenticator(
            {
              providerRegistrations: workerDependencies.oidcProviderRegistrations,
              subjectTokenAudience: audience,
            },
            {
              fetch: (input, init) => workerDependencies.fetch(input, init),
              now: () => workerDependencies.now(),
              observe: (event) => console.warn(event),
            },
          ),
          tokenIssuancePolicy: workerDependencies.tokenIssuancePolicy,
        }),
      };

      if (configuredRuntime.audience !== audience) {
        throw new TypeError(
          "TOKEN_BROKER_AUDIENCE must not change during a Worker isolate lifetime",
        );
      }
      const tokenExchange = configuredRuntime.tokenExchange;

      const url = new URL(request.url);

      if (url.pathname !== "/token") {
        return problemResponse(404);
      }

      if (request.method !== "POST") {
        return tokenExchangeMethodNotAllowedResponse();
      }

      return handleTokenExchangeRequest(request, {
        exchange: (input) =>
          tokenExchange.exchange({
            ...input,
            githubApp: githubApp(env),
          }),
        now: () => workerDependencies.now(),
        rateLimit: async (key) => {
          const result = await env.TOKEN_EXCHANGE_RATE_LIMIT.limit({ key });

          return result.success;
        },
      });
    },
  };
}

function githubApp(env: TokenExchangeWorkerEnv) {
  return {
    GITHUB_APP_ID: env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY,
  };
}
