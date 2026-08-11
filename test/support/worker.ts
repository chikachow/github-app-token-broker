import {
  createTokenExchangeWorker,
  type TokenExchangeWorkerDependencies,
} from "@github-app-token-broker/worker";
import { configuredOidcProviderRegistrations } from "../../workers/github-app-token-broker/src/configured-oidc-provider-registrations.ts";

import { testNow } from "./constants.ts";
import { fetchGitHubTestDouble } from "./github-api.ts";
import { fetchOidcRemoteDocumentResponseTestDouble } from "./oidc.ts";
import { testTokenIssuancePolicy } from "./token-issuance-policy.ts";
import { testEnv } from "./worker-env.ts";

export {
  authorizationHeaders,
  githubInstallationAccessTokenType,
  tokenExchangeRequestBody,
} from "./oidc.ts";
export { testEnv };

type TestEnv = TokenExchangeEnv;

export const testTokenExchangeWorkerDependencies = {
  fetch: fetchTokenExchangeExternalTestDouble,
  now: () => testNow,
  oidcProviderRegistrations: configuredOidcProviderRegistrations,
  tokenIssuancePolicy: testTokenIssuancePolicy,
} satisfies TokenExchangeWorkerDependencies;

const tokenExchangeApp = createTokenExchangeWorker(testTokenExchangeWorkerDependencies);

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
  dependencies: Partial<TokenExchangeWorkerDependencies>,
): Promise<Response> {
  return fetchWorkerWithApp(
    createTokenExchangeWorker({
      ...testTokenExchangeWorkerDependencies,
      ...dependencies,
    }),
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

const oidcProviderHostnames = new Set([
  "accounts.google.com",
  "token.actions.githubusercontent.com",
  "www.googleapis.com",
]);
