import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  deps: { alwaysBundle: [/^@github-app-token-broker\//u] },
  dts: true,
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  target: "node24",
});
