import { jsonResponse, problemResponse } from "@github-app-token-broker/http/problem-details";
import {
  compileGitHubAppTokenExchange,
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
  const dependencies = Object.freeze({
    fetch: runtimeDependencies.fetch,
    now: runtimeDependencies.now,
    observe: runtimeDependencies.observe ?? observeTokenExchangeWithConsole,
    observeOidcDiagnostic:
      runtimeDependencies.observeOidcDiagnostic ?? observeOidcDiagnosticWithConsole,
  });
  // Validate and capture build-time trust before any request or secret access.
  const tokenExchange = compileGitHubAppTokenExchange({ composition, githubApps }, dependencies);
  const appsByPath = new Map(githubApps.map((app) => [`/github/apps/${app.slug}/token`, app]));

  return {
    async fetch(request, env) {
      try {
        const url = new URL(request.url);

        const app = appsByPath.get(url.pathname);
        if (app === undefined) {
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

        // Credential references belong to this request; issuer state belongs to the runtime.
        const requestTokenExchange = tokenExchange.bindPrivateKey(
          url.pathname,
          githubAppConfigurationFromWorkerBinding(app, Reflect.get(env, app.privateKeyBinding)),
        );

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
