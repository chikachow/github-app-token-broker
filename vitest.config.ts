import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["**/*.d.ts"],
      include: ["packages/*/dist/**/*.js", "workers/*/dist/**/*.js"],
      provider: "v8",
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
        test: {
          allowOnly: false,
          include: ["test/node/**/*.test.ts"],
          name: "node",
        },
      },
      {
        test: {
          allowOnly: false,
          include: ["test/fastify/**/*.test.ts"],
          name: "fastify",
        },
      },
      {
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
