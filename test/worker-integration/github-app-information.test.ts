import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "wrangler";
import { githubAppInformationNodeFixture } from "../support/github-app-information-node-fixture.ts";

describe("GitHub App Information RPC", () => {
  const server = createTestHarness({
    workers: [
      {
        configPath: "test/worker-integration/wrangler.jsonc",
        secrets: githubAppInformationNodeFixture.privateKeyBindings,
      },
    ],
  });
  const outbound = vi.fn<typeof fetch>(async (input, init) => {
    const response = githubAppInformationNodeFixture.responseForRequest(new Request(input, init));
    if (response === null) throw new Error("Unexpected outbound RPC request");
    return response;
  });
  beforeAll(async () => {
    vi.stubGlobal("fetch", outbound);
    await server.listen();
  }, 30_000);
  afterEach(() => outbound.mockClear());
  afterAll(async () => {
    try {
      await server.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("passes installation input and output through the named Worker entrypoint", async () => {
    const response = await server.fetch("/APP_A");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      account: { login: "fixture-owner" },
      app_id: 2419473,
      id: 12345,
      repository_selection: "all",
    });
    expect(outbound).toHaveBeenCalledTimes(1);
  });
  it("lets one consumer bind separately to two apps with distinct keys", async () => {
    const responses = await Promise.all([server.fetch("/APP_A"), server.fetch("/APP_B")]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const [first, second] = await Promise.all(responses.map((response) => response.json()));
    expect(first).toMatchObject({ app_id: 2419473 });
    expect(second).toMatchObject({ app_id: 7654321 });
    expect(outbound).toHaveBeenCalledTimes(2);
  });
  it.each(["APP_MISSING_SELECTOR", "APP_UNKNOWN_SELECTOR"] as const)(
    "rejects %s through a real binding without GitHub I/O",
    async (binding) => {
      const response = await server.fetch(`/${binding}`);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ name: "GitHubAppConfigurationError" });
      expect(outbound).not.toHaveBeenCalled();
    },
  );
});
