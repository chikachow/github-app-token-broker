import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

import { githubAppInformationNodeFixture } from "./test/support/github-app-information-node-fixture.ts";

const tokenExchangeSourceAlias = {
  "@github-app-token-broker/token-exchange": new URL(
    "./packages/token-exchange/src/index.ts",
    import.meta.url,
  ).pathname,
};

const fastifySourceAlias = {
  "@github-app-token-broker/fastify": new URL("./packages/fastify/src/index.ts", import.meta.url)
    .pathname,
};

export default defineConfig({
  test: {
    coverage: {
      exclude: ["**/*.test.ts", "packages/*/dist/**", "test/**", "worker-configuration.d.ts"],
      provider: "istanbul",
      reporter: ["text", "lcov"],
    },
    projects: [
      {
        plugins: [
          cloudflareTest({
            miniflare: {
              bindings: {
                GITHUB_APP_ID: "2419473",
                TOKEN_BROKER_AUDIENCE: "https://broker.example",
              },
            },
            remoteBindings: false,
            wrangler: {
              configPath: "./wrangler.jsonc",
            },
          }),
        ],
        resolve: { alias: tokenExchangeSourceAlias },
        test: {
          allowOnly: false,
          detectAsyncLeaks: true,
          exclude: [
            ...configDefaults.exclude,
            "test/fastify/**/*.test.ts",
            "test/properties/**/*.property.test.ts",
            "test/worker-integration/**",
          ],
          name: "unit",
        },
      },
      {
        resolve: { alias: { ...fastifySourceAlias, ...tokenExchangeSourceAlias } },
        test: {
          allowOnly: false,
          include: ["test/fastify/**/*.test.ts"],
          name: "fastify",
        },
      },
      {
        resolve: { alias: tokenExchangeSourceAlias },
        test: {
          allowOnly: false,
          include: ["test/properties/**/*.property.test.ts"],
          name: "property",
        },
      },
      {
        plugins: [
          cloudflareTest({
            miniflare: {
              bindings: {
                GITHUB_APP_ID: githubAppInformationNodeFixture.appId,
                GITHUB_APP_PRIVATE_KEY: githubAppInformationNodeFixture.privateKeyPem,
              },
              outboundService(request) {
                return githubAppInformationNodeFixture.responseForRequest(request);
              },
            },
            remoteBindings: false,
            wrangler: {
              configPath: "./workers/github-app-token-broker/wrangler.jsonc",
            },
          }),
        ],
        resolve: { alias: tokenExchangeSourceAlias },
        test: {
          allowOnly: false,
          detectAsyncLeaks: true,
          include: ["test/worker-integration/**/*.test.ts"],
          name: "worker-integration",
          testTimeout: 10_000,
        },
      },
    ],
  },
});
