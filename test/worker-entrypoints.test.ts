import tokenExchangeWorker from "@github-app-token-broker/worker";
import { describe, expect, it } from "vitest";

import rootHarness from "./support/root-test-harness.ts";

describe("worker entrypoint shapes", () => {
  it("exposes only the token-exchange fetch worker", () => {
    expect(tokenExchangeWorker.fetch).toEqual(expect.any(Function));
    expect(tokenExchangeWorker.queue).toBeUndefined();
  });

  it("does not route product endpoints through the root test harness", async () => {
    const response = await Promise.resolve(
      rootHarness.fetch(new Request("https://example.test/token"), {}, {} as ExecutionContext),
    );

    expect(response.status).toBe(404);
  });
});
