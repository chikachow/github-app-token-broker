import { describe, expect, it } from "vitest";

import { readRequestBodyUpTo } from "@github-app-token-broker/http/request-body";

describe("bounded request body reading", () => {
  it("accepts a Content-Length with leading zeroes", async () => {
    const result = await readRequestBodyUpTo(
      new Request("https://example.test", {
        body: "x",
        headers: { "content-length": "0001" },
        method: "POST",
      }),
      1,
    );

    expect(result).toEqual({
      bytes: new TextEncoder().encode("x"),
      ok: true,
    });
  });

  it("rejects an arbitrarily large Content-Length as too large without integer conversion", async () => {
    const result = await readRequestBodyUpTo(
      new Request("https://example.test", {
        body: "x",
        headers: { "content-length": "9".repeat(400) },
        method: "POST",
      }),
      1,
    );

    expect(result).toEqual({ ok: false, status: 413 });
  });

  it.each(["", "+1", "-1", "1.0", "1e3"])(
    "rejects a Content-Length outside the HTTP decimal grammar: %j",
    async (contentLength) => {
      const result = await readRequestBodyUpTo(
        new Request("https://example.test", {
          body: "x",
          headers: { "content-length": contentLength },
          method: "POST",
        }),
        1,
      );

      expect(result).toEqual({ ok: false, status: 400 });
    },
  );
});
