import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  deps: {
    alwaysBundle: [/^@github-app-token-broker\//u],
    onlyBundle: [
      "@github-app-token-broker/fastify",
      "@github-app-token-broker/token-exchange",
      "jose",
      "zod",
    ],
  },
  entry: ["src/normal.ts", "src/observation-failure.ts"],
  fixedExtension: false,
  format: "esm",
  platform: "node",
  target: "node24",
});
