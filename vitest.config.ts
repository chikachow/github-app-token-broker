import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

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
                GITHUB_APP_ID: "000000",
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
          exclude: [...configDefaults.exclude, "test/node/**", "test/worker-integration/**"],
          name: "unit",
        },
      },
      {
        plugins: [
          cloudflareTest({
            miniflare: {
              bindings: {
                GITHUB_APP_PRIVATE_KEY: "unused-because-token-issuance-policy-denies",
                OIDC_TEST_PRIVATE_KEY: tokenExchangeOidcNodeFixture.privateKeyPem,
                TOKEN_BROKER_AUDIENCE: "https://broker.example",
              },
              outboundService: tokenExchangeOidcNodeFixture.outboundService,
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
          include: ["test/worker-integration/token-exchange.test.ts"],
          name: "token-exchange-integration",
          testTimeout: 10_000,
        },
      },
    ],
  },
});
