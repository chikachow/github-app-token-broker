import { problemResponse } from "@github-app-token-broker/http/problem-details";
import type { SecretTextBinding } from "@github-app-token-broker/github/secrets";
import type { InstallationAccessTokenExchange } from "./installation-access-token-exchange.ts";
import { parseSubjectTokenAudience } from "./subject-token-audience.ts";
import {
  handleTokenExchangeRequest,
  tokenExchangeMethodNotAllowedResponse,
} from "./token-exchange.ts";
import {
  createInstallationAccessTokenExchangeForWorker,
  defaultTokenExchangeWorkerRuntimeDependencies,
} from "./dependencies.ts";
import {
  assertTokenIssuancePolicyIssuersAreRegistered,
  type TokenIssuancePolicy,
} from "@github-app-token-broker/token-issuance-policy";
import type { OidcProviderRegistration } from "@github-app-token-broker/oidc/provider-registration";

export interface TokenExchangeComposition {
  readonly oidcProviderRegistrations: readonly OidcProviderRegistration[];
  readonly tokenIssuancePolicy: TokenIssuancePolicy;
}

export interface TokenExchangeWorkerRuntimeDependencies {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
}

export interface TokenExchangeWorkerEnv {
  readonly GITHUB_API_BASE_URL?: string;
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_PRIVATE_KEY: SecretTextBinding;
  readonly TOKEN_BROKER_AUDIENCE: string;
  readonly TOKEN_EXCHANGE_RATE_LIMIT: {
    limit(options: { readonly key: string }): Promise<{ readonly success: boolean }>;
  };
}

export function createTokenExchangeWorker(
  composition: TokenExchangeComposition,
  runtimeDependencies: TokenExchangeWorkerRuntimeDependencies = defaultTokenExchangeWorkerRuntimeDependencies,
): ExportedHandler<TokenExchangeWorkerEnv> {
  const oidcProviderRegistrations = Object.freeze([...composition.oidcProviderRegistrations]);
  assertOidcProviderRegistrationIssuersAreUnique(oidcProviderRegistrations);
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
        readonly audience: string;
        readonly tokenExchange: InstallationAccessTokenExchange;
      }
    | undefined;

  return {
    fetch(request, env) {
      const audience = parseSubjectTokenAudience(env.TOKEN_BROKER_AUDIENCE);
      configuredRuntime ??= {
        audience,
        tokenExchange: createInstallationAccessTokenExchangeForWorker(workerDependencies, audience),
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

function assertOidcProviderRegistrationIssuersAreUnique(
  registrations: readonly OidcProviderRegistration[],
): void {
  const issuers = new Set<string>();

  for (const registration of registrations) {
    if (issuers.has(registration.issuer)) {
      throw new TypeError("duplicate OIDC Provider Registration issuer");
    }

    issuers.add(registration.issuer);
  }
}

function githubApp(env: TokenExchangeWorkerEnv) {
  return {
    ...(env.GITHUB_API_BASE_URL === undefined
      ? {}
      : { GITHUB_API_BASE_URL: env.GITHUB_API_BASE_URL }),
    GITHUB_APP_ID: env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY,
  };
}
