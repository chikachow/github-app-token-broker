import {
  createTokenExchangeWorker,
  type TokenExchangeComposition,
  type TokenExchangeWorkerEnv,
  type TokenExchangeWorkerRuntimeDependencies,
} from "@github-app-token-broker/worker";
import { githubActionsOidcProviderRegistration } from "@github-app-token-broker/oidc-provider-github-actions";

import { testNow } from "./constants.ts";
import { fetchGitHubTestDouble } from "./github-api.ts";
import { fetchOidcRemoteDocumentResponseTestDouble } from "./oidc.ts";
import { testTokenIssuancePolicy } from "./token-issuance-policy.ts";
import { testEnv } from "./worker-env.ts";

export {
  authorizationHeaders,
  accessTokenType,
  legacyGithubInstallationAccessTokenType,
  tokenExchangeRequestBody,
} from "./oidc.ts";
export { testEnv };

type TestEnv = TokenExchangeWorkerEnv;

export const testTokenExchangeComposition = {
  oidcProviderRegistrations: [githubActionsOidcProviderRegistration],
  tokenIssuancePolicy: testTokenIssuancePolicy,
} satisfies TokenExchangeComposition;

export const testTokenExchangeWorkerRuntimeDependencies = {
  fetch: fetchTokenExchangeExternalTestDouble,
  now: () => testNow,
} satisfies TokenExchangeWorkerRuntimeDependencies;

const tokenExchangeApp = createTokenExchangeWorker(
  testTokenExchangeComposition,
  testTokenExchangeWorkerRuntimeDependencies,
);

export function fetchTokenExchange(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return fetchWorkerWithApp(tokenExchangeApp, input, init);
}

export function fetchTokenExchangeWithEnv(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  env: TestEnv,
): Promise<Response> {
  return fetchWorkerWithApp(tokenExchangeApp, input, init, env);
}

export function fetchTokenExchangeWithDependencies(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  overrides: Partial<TokenExchangeComposition & TokenExchangeWorkerRuntimeDependencies>,
): Promise<Response> {
  return fetchWorkerWithApp(
    createTokenExchangeWorker(
      {
        ...testTokenExchangeComposition,
        oidcProviderRegistrations:
          overrides.oidcProviderRegistrations ??
          testTokenExchangeComposition.oidcProviderRegistrations,
        tokenIssuancePolicy:
          overrides.tokenIssuancePolicy ?? testTokenExchangeComposition.tokenIssuancePolicy,
      },
      {
        fetch: overrides.fetch ?? testTokenExchangeWorkerRuntimeDependencies.fetch,
        now: overrides.now ?? testTokenExchangeWorkerRuntimeDependencies.now,
      },
    ),
    input,
    init,
  );
}

function fetchWorkerWithApp(
  app: ExportedHandler<TestEnv>,
  input: RequestInfo | URL,
  init?: RequestInit,
  env: TestEnv = testEnv,
): Promise<Response> {
  const handler = app.fetch;

  if (handler === undefined) {
    throw new Error("test app has no fetch handler");
  }

  return Promise.resolve(
    handler(new Request(input, init) as Parameters<typeof handler>[0], env, {} as ExecutionContext),
  );
}

function fetchTokenExchangeExternalTestDouble(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const hostname = new URL(request.url).hostname;

  return oidcProviderHostnames.has(hostname)
    ? fetchOidcRemoteDocumentResponseTestDouble(request)
    : fetchGitHubTestDouble(request);
}

const oidcProviderHostnames = new Set(["token.actions.githubusercontent.com"]);
