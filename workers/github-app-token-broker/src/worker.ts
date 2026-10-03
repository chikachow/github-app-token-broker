import { snapshotOidcProviderRegistrations } from "@github-app-token-broker/oidc/provider-registration";
import { compileTokenIssuancePolicy } from "@github-app-token-broker/token-issuance-policy";
import { jsonResponse, problemResponse } from "@github-app-token-broker/http/problem-details";
import {
  createGitHubAppTokenExchange,
  type ObserveOidcDiagnostic,
  type ObserveTokenExchange,
  type TokenExchangeComposition,
  tokenExchangeInvalidRequestResponse,
} from "@github-app-token-broker/token-exchange";
import {
  observeOidcDiagnosticWithConsole,
  observeTokenExchangeWithConsole,
} from "./observability.ts";
import {
  githubAppConfigurationFromWorkerBinding,
  snapshotGitHubAppWorkerConfigurations,
  type GitHubAppWorkerConfiguration,
} from "./github-app-bindings.ts";

export interface TokenExchangeWorkerRuntimeDependencies {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly observe?: ObserveTokenExchange;
  readonly observeOidcDiagnostic?: ObserveOidcDiagnostic;
}

export interface TokenExchangeWorkerComposition extends TokenExchangeComposition {
  readonly githubApps: readonly GitHubAppWorkerConfiguration[];
}

export interface TokenExchangeWorkerEnv {
  readonly TOKEN_EXCHANGE_RATE_LIMIT: {
    limit(options: { readonly key: string }): Promise<{ readonly success: boolean }>;
  };
}

export function createTokenExchangeWorker(
  composition: TokenExchangeWorkerComposition,
  runtimeDependencies: TokenExchangeWorkerRuntimeDependencies = {
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
  },
): ExportedHandler<TokenExchangeWorkerEnv> {
  const githubApps = snapshotGitHubAppWorkerConfigurations(composition.githubApps);
  const capturedComposition = Object.freeze({
    oidcProviderRegistrations: snapshotOidcProviderRegistrations(
      composition.oidcProviderRegistrations,
    ),
    tokenIssuancePolicy: compileTokenIssuancePolicy(
      composition.tokenIssuancePolicy.permitStatements,
    ),
  });
  const dependencies = Object.freeze({
    fetch: runtimeDependencies.fetch,
    now: runtimeDependencies.now,
    observe: runtimeDependencies.observe ?? observeTokenExchangeWithConsole,
    observeOidcDiagnostic:
      runtimeDependencies.observeOidcDiagnostic ?? observeOidcDiagnosticWithConsole,
  });
  const createRuntime = (bindings: readonly unknown[]) =>
    createGitHubAppTokenExchange(
      {
        composition: capturedComposition,
        githubApps: githubApps.map((app, index) => ({
          ...app,
          ...githubAppConfigurationFromWorkerBinding(app, bindings[index]),
        })),
      },
      dependencies,
    );
  // Validate and capture build-time trust before any request or secret access.
  let tokenExchange = createRuntime([]);
  let configuredBindings: readonly unknown[] | undefined;
  const paths = new Set(githubApps.map((app) => `/github/apps/${app.slug}/token`));

  return {
    async fetch(request, env) {
      try {
        const url = new URL(request.url);

        if (!paths.has(url.pathname)) {
          return problemResponse(404);
        }

        const bindings: readonly unknown[] = githubApps.map(
          (app) => Reflect.get(env, app.privateKeyBinding) as unknown,
        );
        if (
          configuredBindings === undefined ||
          bindings.some((value, index) => value !== configuredBindings?.[index])
        ) {
          tokenExchange = createRuntime(bindings);
          configuredBindings = bindings;
        }
        // Keep this request on its captured bindings across asynchronous rate limiting.
        const requestTokenExchange = tokenExchange;

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

        return await requestTokenExchange(request, context);
      } catch (error) {
        return unexpectedTokenExchangeFailureResponse(error);
      }
    },
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
