import { githubAppTokenExchangePlugin } from "@github-app-token-broker/fastify";
import { githubActionsOidcProviderRegistration } from "@github-app-token-broker/oidc-provider-github-actions";
import { createGitHubAppTokenExchange } from "@github-app-token-broker/token-exchange";
import { compileTokenIssuancePolicy } from "@github-app-token-broker/token-issuance-policy";
import Fastify, { type FastifyInstance } from "fastify";

/** @public */
export async function createExampleFastifyHost(): Promise<FastifyInstance> {
  const app = Fastify();
  const tokenExchange = createGitHubAppTokenExchange({
    composition: {
      oidcProviderRegistrations: [githubActionsOidcProviderRegistration],
      tokenIssuancePolicy: compileTokenIssuancePolicy([]),
    },
    githubApp: {
      appId: "example",
      privateKey: "example-only-not-a-real-key",
    },
    subjectTokenAudience: "https://broker.example",
  });

  await app.register(githubAppTokenExchangePlugin, { tokenExchange });
  return app;
}
