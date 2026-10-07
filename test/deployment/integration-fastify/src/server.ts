import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { githubAppTokenExchangePlugin } from "@github-app-token-broker/fastify";
import { createGitHubAppTokenExchange } from "@github-app-token-broker/token-exchange";
import Fastify, { type FastifyServerOptions } from "fastify";
import { composition } from "../../../integration/composition.ts";

export async function startServer(options: FastifyServerOptions) {
  const app = Fastify(options);
  await app.register(githubAppTokenExchangePlugin, {
    tokenExchange: createGitHubAppTokenExchange({
      composition,
      githubApps: await Promise.all(
        composition.githubApps.map(async (configured) => {
          const file = process.env[`${configured.privateKeyBinding}_FILE`];
          assert.ok(file);
          return { ...configured, privateKey: await readFile(file, "utf8") };
        }),
      ),
    }),
  });
  await app.listen({ host: "0.0.0.0", port: 8080 });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void app.close();
    });
  }
}
