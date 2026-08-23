import {
  createGitHubAppTokenExchange,
  type GitHubAppTokenExchangeConfiguration,
  type TokenExchangeComposition,
  type TokenExchangeHandler,
  type TokenExchangeRequestContext,
  type TokenExchangeRuntimeDependencies,
} from "@github-app-token-broker/token-exchange";

declare const composition: TokenExchangeComposition;

const configuration = Object.freeze({
  composition,
  githubApp: Object.freeze({ appId: "1", privateKey: "fixture-private-key" }),
  subjectTokenAudience: "https://broker.example",
}) satisfies GitHubAppTokenExchangeConfiguration;
const context = Object.freeze({
  observe: async () => undefined,
  observeOidcDiagnostic: () => undefined,
}) satisfies TokenExchangeRequestContext;
const runtime = Object.freeze({
  fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  now: () => new Date(),
}) satisfies TokenExchangeRuntimeDependencies;
const handler: TokenExchangeHandler = createGitHubAppTokenExchange(configuration, runtime);
const request = new Request("https://broker.example/token", { method: "POST" });

void handler(request, context);

const invalidConfiguration: GitHubAppTokenExchangeConfiguration = {
  ...configuration,
  githubApp: {
    ...configuration.githubApp,
    // @ts-expect-error The GitHub API destination is intentionally absent from public config.
    apiBaseUrl: "https://attacker.invalid",
  },
};

void invalidConfiguration;
