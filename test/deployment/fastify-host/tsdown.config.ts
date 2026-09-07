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
  dts: true,
  entry: ["src/index.ts"],
  fixedExtension: false,
  format: "esm",
  platform: "node",
  target: "node24",
});
