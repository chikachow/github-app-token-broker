import { githubAppTokenExchangePlugin } from "@github-app-token-broker/fastify";
import { createGitHubAppTokenExchange } from "@github-app-token-broker/token-exchange";
import Fastify, { type FastifyInstance } from "fastify";

/** @public */
export async function createExampleFastifyHost(): Promise<FastifyInstance> {
  const app = Fastify();
  const tokenExchange = createGitHubAppTokenExchange({
    composition: {
      oidcProviderRegistrations: [],
      tokenIssuancePolicy: { permitStatements: [] },
    },
    githubApps: [
      {
        slug: "fixture-app",
        subjectTokenAudiences: ["https://broker.example"],
        clientId: "example",
        privateKey: "example-only-not-a-real-private-key",
      },
    ],
  });

  await app.register(githubAppTokenExchangePlugin, {
    prefix: "/automation",
    tokenExchange,
  });
  return app;
}
