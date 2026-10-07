import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

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
      exclude: ["**/*.d.ts"],
      include: ["packages/*/src/**/*.ts", "workers/*/src/**/*.ts"],
      provider: "istanbul",
      reporter: ["text", "lcov"],
      thresholds: {
        branches: 94,
        functions: 98,
        lines: 97,
        statements: 97,
      },
    },
    projects: [
      {
        plugins: [
          cloudflareTest({
            miniflare: {
              bindings: {},
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
            "test/node/**/*.test.ts",
            "test/properties/**/*.property.test.ts",
            "test/worker-integration/**",
          ],
          name: "unit",
        },
      },
      {
        resolve: { alias: tokenExchangeSourceAlias },
        test: {
          allowOnly: false,
          include: ["test/node/**/*.test.ts"],
          name: "node",
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
          testTimeout: 10_000,
        },
      },
      {
        test: {
          allowOnly: false,
          include: ["test/worker-integration/**/*.test.ts"],
          name: "worker-integration",
          testTimeout: 10_000,
        },
      },
    ],
  },
});
