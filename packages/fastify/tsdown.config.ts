import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  deps: {
    neverBundle: ["fastify", "@github-app-token-broker/token-exchange"],
  },
  dts: true,
  entry: ["src/index.ts"],
  fixedExtension: false,
  format: "esm",
  platform: "node",
  target: "node24",
});
