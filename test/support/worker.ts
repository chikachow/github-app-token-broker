import {
  createTokenExchangeWorker,
  type TokenExchangeWorkerComposition,
  type TokenExchangeWorkerEnv,
  type TokenExchangeWorkerRuntimeDependencies,
} from "@github-app-token-broker/worker";
import {
  testGitHubActionsTokenExchangeConfiguration,
  fetchGitHubActionsTokenExchangeExternalTestDouble,
} from "./github-actions-token-exchange.ts";

import { testNow } from "./constants.ts";
import { testEnv } from "./worker-env.ts";

export { testEnv };

type TestEnv = TokenExchangeWorkerEnv & {
  readonly GITHUB_APP_PRIVATE_KEY: import("@github-app-token-broker/github/secrets").SecretTextBinding;
};

export const testGitHubActionsTokenExchangeComposition = {
  ...testGitHubActionsTokenExchangeConfiguration.composition,
  githubApps: [
    {
      clientId: "Iv1.fixtureApp",
      slug: "fixture-app",
      privateKeyBinding: "GITHUB_APP_PRIVATE_KEY",
      subjectTokenAudiences: ["https://broker.example"],
    },
  ],
} as const satisfies TokenExchangeWorkerComposition;

export const testGitHubActionsTokenExchangeWorkerRuntimeDependencies = {
  fetch: fetchGitHubActionsTokenExchangeExternalTestDouble,
  now: () => testNow,
  observe: async () => undefined,
} satisfies TokenExchangeWorkerRuntimeDependencies;

const githubActionsTokenExchangeWorker = createTokenExchangeWorker(
  testGitHubActionsTokenExchangeComposition,
  testGitHubActionsTokenExchangeWorkerRuntimeDependencies,
);

export function fetchGitHubActionsTokenExchange(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return fetchWorkerWithApp(githubActionsTokenExchangeWorker, input, init);
}

export function fetchGitHubActionsTokenExchangeWithEnv(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  env: TestEnv,
): Promise<Response> {
  return fetchWorkerWithApp(githubActionsTokenExchangeWorker, input, init, env);
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
