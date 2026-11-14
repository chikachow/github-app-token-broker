import {
  createGitHubAppTokenExchange,
  compileGitHubAppTokenExchange,
  snapshotGitHubAppMetadata,
  unexpectedTokenExchangeFailureResponse,
  type GitHubAppTokenExchangeFactory,
  type TokenExchangeGitHubAppMetadata,
  type GitHubAppTokenExchangeConfiguration,
  type GitHubAppTokenExchangeHandler,
  type TokenExchangeComposition,
  type TokenExchangeHandler,
  type TokenExchangeRequestContext,
  type TokenExchangeRuntimeDependencies,
} from "@github-app-token-broker/core";
import type { GitHubAppInformation } from "@github-app-token-broker/core/github/app-information";
import type { OidcProviderRegistration } from "@github-app-token-broker/core/oidc/provider-registration";
import { buildkiteOidcProviderRegistration } from "@github-app-token-broker/core/providers/buildkite";
import { createFlyOidcProviderRegistration } from "@github-app-token-broker/core/providers/fly";
import { githubActionsOidcProviderRegistration } from "@github-app-token-broker/core/providers/github-actions";
import { googleServiceAccountOidcProviderRegistration } from "@github-app-token-broker/core/providers/google-service-account";
import type { TokenIssuancePolicy } from "@github-app-token-broker/core/token-issuance-policy";

const oidcProviderRegistrations: readonly OidcProviderRegistration[] = [
  buildkiteOidcProviderRegistration,
  createFlyOidcProviderRegistration("fixture-org"),
  githubActionsOidcProviderRegistration,
  googleServiceAccountOidcProviderRegistration,
];
const tokenIssuancePolicy: TokenIssuancePolicy = { permitStatements: [] };
const composition: TokenExchangeComposition = { oidcProviderRegistrations, tokenIssuancePolicy };
declare const appInformation: GitHubAppInformation;
void appInformation.getRepositoryInstallation({ owner: "fixture-owner", repo: "fixture-repo" });
declare const unexpectedFailure: unknown;
const failureResponse: Response = unexpectedTokenExchangeFailureResponse(unexpectedFailure);
void failureResponse;

const configuration = Object.freeze({
  composition,
  githubApps: [
    Object.freeze({
      slug: "fixture-app",
      clientId: "Iv1.fixtureApp",
      privateKey: "fixture-private-key",
      subjectTokenAudiences: ["https://broker.example"],
    }),
  ],
}) satisfies GitHubAppTokenExchangeConfiguration;
const context = Object.freeze({
  observe: async () => undefined,
  observeOidcDiagnostic: () => undefined,
}) satisfies TokenExchangeRequestContext;
const runtime = Object.freeze({
  fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  now: () => new Date(),
}) satisfies TokenExchangeRuntimeDependencies;
const handler: GitHubAppTokenExchangeHandler = createGitHubAppTokenExchange(configuration, runtime);
const paths: readonly string[] = handler.tokenEndpointPaths;
const fetchHandler: TokenExchangeHandler = handler;
void paths;
void fetchHandler;
const request = new Request("https://broker.example/github/apps/fixture-app/token", {
  method: "POST",
});

void handler(request, context);

const metadata: readonly TokenExchangeGitHubAppMetadata[] = snapshotGitHubAppMetadata(
  configuration.githubApps,
);
const compiled: GitHubAppTokenExchangeFactory = compileGitHubAppTokenExchange(
  { composition, githubApps: metadata },
  runtime,
);
const bound: GitHubAppTokenExchangeHandler = compiled.bindPrivateKeys(configuration.githubApps);
void bound(request, context);
const selected: TokenExchangeHandler = compiled.bindPrivateKey(
  "/github/apps/fixture-app/token",
  configuration.githubApps[0]!,
);
void selected(request, context);

const invalidConfiguration: GitHubAppTokenExchangeConfiguration = {
  ...configuration,
  githubApps: [
    {
      ...configuration.githubApps[0]!,
      // @ts-expect-error The GitHub API destination is intentionally absent from public config.
      apiBaseUrl: "https://attacker.invalid",
    },
  ],
};

void invalidConfiguration;

const workerBindings = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "fixture-private-key",
};
const invalidWorkerBindingConfiguration: GitHubAppTokenExchangeConfiguration = {
  ...configuration,
  // @ts-expect-error Worker binding names are adapted before runtime-neutral composition.
  githubApps: workerBindings,
};

void invalidWorkerBindingConfiguration;
