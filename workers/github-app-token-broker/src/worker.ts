import type { GitHubAppConfiguration } from "@github-app-token-broker/github/app";
import { jsonResponse, problemResponse } from "@github-app-token-broker/http/problem-details";
import {
  snapshotOidcProviderRegistrations,
  type OidcProviderRegistration,
} from "@github-app-token-broker/oidc/provider-registration";
import {
  parseSubjectTokenAudience,
  type SubjectTokenAudience,
} from "@github-app-token-broker/oidc/subject-token-audience";
import {
  createGitHubAppTokenExchange,
  type ObserveOidcDiagnostic,
  type ObserveTokenExchange,
  type TokenExchangeComposition,
  type TokenExchangeHandler,
  tokenExchangeInvalidRequestResponse,
} from "@github-app-token-broker/token-exchange";
import {
  assertTokenIssuancePolicyIssuersAreRegistered,
  type TokenIssuancePolicy,
} from "@github-app-token-broker/token-issuance-policy";

import {
  observeOidcDiagnosticWithConsole,
  observeTokenExchangeWithConsole,
} from "./observability.ts";
import {
  githubAppConfigurationFromWorkerBindings,
  type GitHubAppWorkerBindings,
} from "./github-app-bindings.ts";

export type { TokenExchangeComposition } from "@github-app-token-broker/token-exchange";

export interface TokenExchangeWorkerRuntimeDependencies {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly observe?: ObserveTokenExchange;
  readonly observeOidcDiagnostic?: ObserveOidcDiagnostic;
}

export interface TokenExchangeWorkerEnv extends GitHubAppWorkerBindings {
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
  const capturedComposition = Object.freeze({ oidcProviderRegistrations, tokenIssuancePolicy });
  const dependencies = Object.freeze({
    fetch: runtimeDependencies.fetch,
    now: runtimeDependencies.now,
    observe: runtimeDependencies.observe ?? observeTokenExchangeWithConsole,
    observeOidcDiagnostic:
      runtimeDependencies.observeOidcDiagnostic ?? observeOidcDiagnosticWithConsole,
  });
  let configuredRuntime: ConfiguredTokenExchangeRuntime | undefined;

  return {
    async fetch(request, env) {
      try {
        const audience = parseSubjectTokenAudience(env.TOKEN_BROKER_AUDIENCE);
        const githubApp = githubAppConfigurationFromWorkerBindings(env);

        if (configuredRuntime === undefined) {
          configuredRuntime = createConfiguredRuntime(
            githubApp,
            audience,
            capturedComposition,
            dependencies,
          );
        } else if (configuredRuntime.audience !== audience) {
          throw new TypeError(
            "TOKEN_BROKER_AUDIENCE must not change during a Worker isolate lifetime",
          );
        } else if (
          configuredRuntime.appId !== githubApp.appId ||
          configuredRuntime.privateKey !== githubApp.privateKey
        ) {
          configuredRuntime = createConfiguredRuntime(
            githubApp,
            audience,
            capturedComposition,
            dependencies,
          );
        }
        const tokenExchange = configuredRuntime.tokenExchange;

        const url = new URL(request.url);

        if (url.pathname !== "/token") {
          return problemResponse(404);
        }

        const context = {
          observe: async (observation: Parameters<ObserveTokenExchange>[0]) =>
            await dependencies.observe({
              ...observation,
              fields: {
                ...observation.fields,
                rayId: request.headers.get("cf-ray"),
              },
            }),
          observeOidcDiagnostic: dependencies.observeOidcDiagnostic,
        };

        if (request.method !== "POST") {
          return tokenExchangeInvalidRequestResponse(400);
        }

        const rateLimit = await env.TOKEN_EXCHANGE_RATE_LIMIT.limit({
          key: tokenExchangeRateLimitKey(request),
        });

        if (!rateLimit.success) {
          return workerOAuthErrorResponse(429, "temporarily_unavailable");
        }

        return await tokenExchange(request, context);
      } catch (error) {
        return unexpectedTokenExchangeFailureResponse(error);
      }
    },
  };
}

interface ConfiguredTokenExchangeRuntime {
  readonly appId: string;
  readonly audience: SubjectTokenAudience;
  readonly privateKey: GitHubAppConfiguration["privateKey"];
  readonly tokenExchange: TokenExchangeHandler;
}

function createConfiguredRuntime(
  githubApp: GitHubAppConfiguration,
  audience: SubjectTokenAudience,
  composition: {
    readonly oidcProviderRegistrations: readonly OidcProviderRegistration[];
    readonly tokenIssuancePolicy: TokenIssuancePolicy;
  },
  dependencies: Pick<TokenExchangeWorkerRuntimeDependencies, "fetch" | "now">,
): ConfiguredTokenExchangeRuntime {
  return {
    appId: githubApp.appId,
    audience,
    privateKey: githubApp.privateKey,
    tokenExchange: createGitHubAppTokenExchange(
      {
        composition,
        githubApp,
        subjectTokenAudience: audience,
      },
      dependencies,
    ),
  };
}

function tokenExchangeRateLimitKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

function unexpectedTokenExchangeFailureResponse(error: unknown): Response {
  try {
    console.error({
      error: { name: error instanceof Error ? "Error" : typeof error },
      event: "token_exchange_request_failed",
    });
  } catch {
    // Logging must not prevent the Token Endpoint from returning a sanitized response.
  }

  return workerOAuthErrorResponse(500, "server_error");
}

function workerOAuthErrorResponse(status: number, error: string): Response {
  return jsonResponse(
    { error },
    {
      headers: {
        "cache-control": "no-store",
        pragma: "no-cache",
      },
      status,
    },
  );
}
