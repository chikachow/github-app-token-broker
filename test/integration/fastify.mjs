import { readFile } from "node:fs/promises";
import { githubAppTokenExchangePlugin } from "@github-app-token-broker/fastify";
import { createGitHubAppTokenExchange } from "@github-app-token-broker/token-exchange";
import Fastify from "fastify";
import { composition } from "./composition.ts";

const app = Fastify({ logger: true });
await app.register(githubAppTokenExchangePlugin, {
  tokenExchange: createGitHubAppTokenExchange({
    composition,
    githubApp: {
      appId: "123456",
      privateKey: await readFile("test/integration/.generated/app.pem", "utf8"),
    },
    subjectTokenAudience: "urn:integration:broker",
  }),
});
await app.listen({ host: "0.0.0.0", port: 8080 });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await app.close();
  });
}
