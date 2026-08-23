import { afterEach, describe, expect, it, vi } from "vitest";

import { observeTokenExchangeWithConsole } from "../workers/github-app-token-broker/src/observability.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Token Exchange console observation adapter", () => {
  it.each(["error", "info", "warn"] as const)("writes %s observations", async (level) => {
    const write = vi.spyOn(console, level).mockImplementation(() => undefined);
    const fields = { event: "test_event" };

    await observeTokenExchangeWithConsole({ fields, level });
    await observeTokenExchangeWithConsole({ fields, level, message: "test message" });

    expect(write.mock.calls).toEqual([[fields], ["test message", fields]]);
  });
});
