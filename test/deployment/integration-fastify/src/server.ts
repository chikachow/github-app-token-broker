import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { githubAppTokenExchangePlugin } from "@github-app-token-broker/fastify";
import { createGitHubAppTokenExchange } from "@github-app-token-broker/token-exchange";
import Fastify, { type FastifyServerOptions } from "fastify";
import { composition } from "../../../integration/composition.ts";

export async function startServer(options: FastifyServerOptions) {
  const { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_FILE, TOKEN_BROKER_AUDIENCE } = process.env;
  assert.ok(GITHUB_APP_ID && GITHUB_APP_PRIVATE_KEY_FILE && TOKEN_BROKER_AUDIENCE);
  const app = Fastify(options);
  await app.register(githubAppTokenExchangePlugin, {
    tokenExchange: createGitHubAppTokenExchange({
      composition,
      githubApp: {
        appId: GITHUB_APP_ID,
        privateKey: await readFile(GITHUB_APP_PRIVATE_KEY_FILE, "utf8"),
      },
      subjectTokenAudience: TOKEN_BROKER_AUDIENCE,
    }),
  });
  await app.listen({ host: "0.0.0.0", port: 8080 });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void app.close();
    });
  }
}
