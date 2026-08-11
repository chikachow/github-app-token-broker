import { problemResponse } from "@github-app-token-broker/http/problem-details";
import type { InstallationAccessTokenExchange } from "./installation-access-token-exchange.ts";
import { parseSubjectTokenAudience } from "./subject-token-audience.ts";
import {
  handleTokenExchangeRequest,
  tokenExchangeMethodNotAllowedResponse,
} from "./token-exchange.ts";
import {
  createInstallationAccessTokenExchangeForWorker,
  configuredTokenExchangeWorkerDependencies,
  defaultTokenExchangeWorkerRuntimeDependencies,
} from "./dependencies.ts";
import type {
  TokenExchangeWorkerDependencies,
  TokenExchangeWorkerRuntimeDependencies,
} from "./dependencies.ts";

export type {
  TokenExchangeWorkerDependencies,
  TokenExchangeWorkerRuntimeDependencies,
} from "./dependencies.ts";

export function createTokenExchangeWorker(
  dependencies: TokenExchangeWorkerDependencies,
): ExportedHandler<TokenExchangeEnv> {
  const workerDependencies = Object.freeze({
    fetch: dependencies.fetch,
    now: dependencies.now,
    oidcProviderRegistrations: Object.freeze([...dependencies.oidcProviderRegistrations]),
    tokenIssuancePolicy: dependencies.tokenIssuancePolicy,
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

export function createConfiguredTokenExchangeWorker(
  runtimeDependencies: TokenExchangeWorkerRuntimeDependencies = defaultTokenExchangeWorkerRuntimeDependencies,
): ExportedHandler<TokenExchangeEnv> {
  return createTokenExchangeWorker(configuredTokenExchangeWorkerDependencies(runtimeDependencies));
}

function githubApp(env: TokenExchangeEnv) {
  return {
    ...(env.GITHUB_API_BASE_URL === undefined
      ? {}
      : { GITHUB_API_BASE_URL: env.GITHUB_API_BASE_URL }),
    GITHUB_APP_ID: env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY,
  };
}
