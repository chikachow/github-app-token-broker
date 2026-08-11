import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultTokenExchangeWorkerRuntimeDependencies } from "../../workers/github-app-token-broker/src/dependencies.ts";

describe("production Worker runtime dependencies", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("uses runtime fetch and time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-02T03:04:05Z"));
    const fetchExternal = vi.fn<typeof fetch>(async () => new Response("runtime response"));
    vi.stubGlobal("fetch", fetchExternal);

    await expect(
      defaultTokenExchangeWorkerRuntimeDependencies.fetch("https://example.test/runtime"),
    ).resolves.toHaveProperty("status", 200);
    expect(fetchExternal).toHaveBeenCalledOnce();
    expect(defaultTokenExchangeWorkerRuntimeDependencies.now()).toEqual(
      new Date("2030-01-02T03:04:05Z"),
    );
  });
});
