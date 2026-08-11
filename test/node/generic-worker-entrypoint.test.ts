import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workerDirectory = new URL("../../workers/github-app-token-broker/", import.meta.url);

describe("generic Worker entrypoint", () => {
  it("uses the source-owned generic entrypoint for Wrangler bundle validation", async () => {
    const wranglerConfig = await readFile(new URL("wrangler.jsonc", workerDirectory), "utf8");

    expect(wranglerConfig).toContain('"main": "src/generic-worker.ts"');
  });

  it("keeps the package root named-only", async () => {
    const packageIndex = await readFile(new URL("src/index.ts", workerDirectory), "utf8");

    expect(packageIndex).not.toContain("export default");
  });
});
