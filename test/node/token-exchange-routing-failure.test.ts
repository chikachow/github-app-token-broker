import { createGitHubAppTokenExchange } from "@github-app-token-broker/token-exchange";
import { describe, expect, it, vi } from "vitest";
import { testGitHubActionsTokenExchangeConfiguration } from "../support/github-actions-token-exchange.ts";

describe("Token Exchange routing failure boundary", () => {
  it.each(["throws", "invalid"])("sanitizes a %s URL even when logging fails", async (mode) => {
    const broker = createGitHubAppTokenExchange(testGitHubActionsTokenExchangeConfiguration);
    const request = new Request("https://broker.example/github/apps/fixture-app/token");
    Object.defineProperty(
      request,
      "url",
      mode === "throws"
        ? {
            get() {
              throw new Error("private URL failure");
            },
          }
        : { value: "invalid URL" },
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("private logger failure");
    });
    try {
      const response = await broker(request, { observe: async () => undefined });
      expect(response.status).toBe(500);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      expect(await response.json()).toEqual({ error: "server_error" });
    } finally {
      log.mockRestore();
    }
  });
});
