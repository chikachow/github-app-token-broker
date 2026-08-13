import { problemResponse } from "@github-app-token-broker/http/problem-details";
import {
  createGitHubAppTokenExchange,
  oauthErrorResponse,
  snapshotTokenExchangeComposition,
  type TokenExchangeComposition,
  type TokenExchangeEvent,
  type TokenExchangeHandler,
} from "@github-app-token-broker/token-exchange";

export type { TokenExchangeComposition } from "@github-app-token-broker/token-exchange";

export interface TokenExchangeWorkerRuntimeDependencies {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
}

export interface TokenExchangeWorkerEnv {
  readonly GITHUB_API_BASE_URL?: string;
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_PRIVATE_KEY: string | { readonly get: () => Promise<string> };
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
  const capturedComposition = snapshotTokenExchangeComposition(composition);
  const workerDependencies = Object.freeze({
    fetch: runtimeDependencies.fetch,
    now: runtimeDependencies.now,
  });
  let configuredRuntime:
    | {
        readonly apiBaseUrl: string | undefined;
        readonly appId: string;
        readonly audience: string;
        readonly privateKey: TokenExchangeWorkerEnv["GITHUB_APP_PRIVATE_KEY"];
        readonly tokenExchange: TokenExchangeHandler;
      }
    | undefined;

  return {
    fetch(request, env) {
      const audience = env.TOKEN_BROKER_AUDIENCE;
      configuredRuntime ??= createConfiguredRuntime(env, capturedComposition, workerDependencies);

      if (configuredRuntime.audience !== audience) {
        throw new TypeError(
          "token exchange configuration must not change during a Worker isolate lifetime",
        );
      }
      if (
        configuredRuntime.appId !== env.GITHUB_APP_ID ||
        configuredRuntime.apiBaseUrl !== env.GITHUB_API_BASE_URL ||
        configuredRuntime.privateKey !== env.GITHUB_APP_PRIVATE_KEY
      ) {
        configuredRuntime = createConfiguredRuntime(env, capturedComposition, workerDependencies);
      }
      const tokenExchange = configuredRuntime.tokenExchange;

      const url = new URL(request.url);

      if (url.pathname !== "/token") {
        return problemResponse(404);
      }

      if (request.method !== "POST") {
        return tokenExchange(request, workerRequestContext(request));
      }

      return rateLimitedTokenExchange(request, env, tokenExchange);
    },
  };
}

async function rateLimitedTokenExchange(
  request: Request,
  env: TokenExchangeWorkerEnv,
  tokenExchange: TokenExchangeHandler,
): Promise<Response> {
  const rateLimit = await env.TOKEN_EXCHANGE_RATE_LIMIT.limit({
    key: tokenExchangeRateLimitKey(request),
  });

  if (!rateLimit.success) {
    return oauthErrorResponse(429, "temporarily_unavailable");
  }

  return tokenExchange(request, workerRequestContext(request));
}

function createConfiguredRuntime(
  env: TokenExchangeWorkerEnv,
  composition: TokenExchangeComposition,
  dependencies: TokenExchangeWorkerRuntimeDependencies,
) {
  return {
    apiBaseUrl: env.GITHUB_API_BASE_URL,
    appId: env.GITHUB_APP_ID,
    audience: env.TOKEN_BROKER_AUDIENCE,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    tokenExchange: createGitHubAppTokenExchange(
      {
        composition,
        githubApp: {
          ...(env.GITHUB_API_BASE_URL === undefined ? {} : { apiBaseUrl: env.GITHUB_API_BASE_URL }),
          appId: env.GITHUB_APP_ID,
          privateKey: env.GITHUB_APP_PRIVATE_KEY,
        },
        subjectTokenAudience: env.TOKEN_BROKER_AUDIENCE,
      },
      dependencies,
    ),
  } as const;
}

function workerRequestContext(request: Request) {
  return {
    observe(event: TokenExchangeEvent): void {
      const record = { ...event, rayId: request.headers.get("cf-ray") };
      workerConsoleMethod(event)(record);
    },
  };
}

function workerConsoleMethod(event: TokenExchangeEvent): (event: object) => void {
  switch (event.level) {
    case "error":
      return (value) => console.error(value);
    case "info":
      return (value) => console.info(value);
    case "warn":
      return (value) => console.warn(value);
  }
}

function tokenExchangeRateLimitKey(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ??
    "unknown"
  );
}
