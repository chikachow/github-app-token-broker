import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

import { githubAppInformationNodeFixture } from "./test/support/github-app-information-node-fixture.ts";
import { tokenExchangeOidcNodeFixture } from "./test/support/token-exchange-oidc-node-fixture.ts";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["**/*.test.ts", "test/**", "worker-configuration.d.ts"],
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
        test: {
          allowOnly: false,
          detectAsyncLeaks: true,
          exclude: [...configDefaults.exclude, "test/worker-integration/**"],
          name: "unit",
        },
      },
      {
        plugins: [
          cloudflareTest({
            miniflare: {
              bindings: {
                GITHUB_APP_ID: githubAppInformationNodeFixture.appId,
                GITHUB_APP_PRIVATE_KEY: githubAppInformationNodeFixture.privateKeyPem,
                OIDC_TEST_PRIVATE_KEY: tokenExchangeOidcNodeFixture.privateKeyPem,
                TOKEN_BROKER_AUDIENCE: "https://broker.example",
              },
              outboundService(request) {
                return (
                  githubAppInformationNodeFixture.responseForRequest(request) ??
                  tokenExchangeOidcNodeFixture.outboundService(request)
                );
              },
            },
            remoteBindings: false,
            wrangler: {
              configPath: "./workers/github-app-token-broker/wrangler.jsonc",
            },
          }),
        ],
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
