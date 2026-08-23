import { request as nodeHttpRequest } from "node:http";

import { githubAppTokenExchangePlugin } from "@github-app-token-broker/fastify";
import {
  maxTokenExchangeBodyBytes,
  type TokenExchangeHandler,
} from "@github-app-token-broker/token-exchange";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

describe("githubAppTokenExchangePlugin", () => {
  it("preserves raw form bytes in its prefix without changing an ordinary sibling parser", async () => {
    const tokenExchange = vi.fn<TokenExchangeHandler>(async (request) => {
      expect(request.headers.get("content-type")).toBe(
        "application/x-www-form-urlencoded; charset=utf-8",
      );
      expect(await request.text()).toBe("scope=&scope=contents%3Aread&scope=actions%3Awrite");

      return Response.json({ ok: true });
    });
    const app = Fastify();
    app.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_request, body, done) => done(null, { parsed: body }),
    );
    let ordinaryParsedBody: unknown;
    app.post("/ordinary-form", async (request) => {
      ordinaryParsedBody = request.body;
      return { ok: true };
    });
    await app.register(githubAppTokenExchangePlugin, {
      prefix: "/automation",
      tokenExchange,
    });

    try {
      const response = await app.inject({
        body: "scope=&scope=contents%3Aread&scope=actions%3Awrite",
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        method: "POST",
        url: "/automation/token",
      });
      const ordinaryResponse = await app.inject({
        body: "field=value",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        url: "/ordinary-form",
      });

      expect(response.statusCode).toBe(200);
      expect(tokenExchange).toHaveBeenCalledOnce();
      expect((await app.inject({ method: "POST", url: "/token" })).statusCode).toBe(404);
      expect(ordinaryResponse.statusCode).toBe(200);
      expect(ordinaryResponse.json()).toEqual({ ok: true });
      expect(ordinaryParsedBody).toEqual({ parsed: "field=value" });
    } finally {
      await app.close();
    }
  });

  it.each([
    { contentType: "application/json", scenario: "JSON" },
    { contentType: "text/plain", scenario: "text" },
    { contentType: "not a type", scenario: "malformed media type" },
    { contentType: undefined, scenario: "missing content type" },
  ])("maps unsupported $scenario bodies to OAuth invalid_request", async ({ contentType }) => {
    const tokenExchange = vi.fn<TokenExchangeHandler>();
    const app = Fastify();
    await app.register(githubAppTokenExchangePlugin, { tokenExchange });

    try {
      const response = await app.inject({
        body: "grant_type=ignored",
        ...(contentType === undefined ? {} : { headers: { "content-type": contentType } }),
        method: "POST",
        url: "/token",
      });

      expectOAuthInvalidRequest(response, 400);
      expect(tokenExchange).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("lets an empty request with no content type reach the deep handler", async () => {
    const tokenExchange = vi.fn<TokenExchangeHandler>(async () => Response.json({ reached: true }));
    const app = Fastify();
    await app.register(githubAppTokenExchangePlugin, { tokenExchange });

    try {
      const response = await app.inject({ method: "POST", url: "/token" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ reached: true });
      expect(tokenExchange).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("maps body-limit and invalid-content-length failures to OAuth invalid_request", async () => {
    const tokenExchange = vi.fn<TokenExchangeHandler>();
    const app = Fastify();
    await app.register(githubAppTokenExchangePlugin, { tokenExchange });

    try {
      const oversized = await app.inject({
        body: "x".repeat(maxTokenExchangeBodyBytes + 1),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        url: "/token",
      });
      const invalidContentLength = await app.inject({
        body: "x=1",
        headers: {
          "content-length": "10",
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
        url: "/token",
      });

      expectOAuthInvalidRequest(oversized, 413);
      expectOAuthInvalidRequest(invalidContentLength, 400);
      expect(tokenExchange).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("preserves status, binary bodies, and separate Set-Cookie response fields", async () => {
    const headers = new Headers({
      "cache-control": "no-store",
      "content-type": "application/octet-stream",
    });
    headers.append("set-cookie", "first=value; Path=/; HttpOnly");
    headers.append("set-cookie", "second=value; Path=/; Secure");
    headers.append("x-observation", "one");
    headers.append("x-observation", "two");
    const hookObservations: Array<Record<string, unknown>> = [];
    const app = Fastify();
    app.addHook("onSend", async (_request, reply, payload) => {
      hookObservations.push({
        cacheControl: reply.getHeader("cache-control"),
        contentType: reply.getHeader("content-type"),
        payloadIsBuffer: Buffer.isBuffer(payload),
        setCookie: reply.getHeader("set-cookie"),
        statusCode: reply.statusCode,
      });
      return payload;
    });
    await app.register(githubAppTokenExchangePlugin, {
      tokenExchange: async () =>
        new Response(Uint8Array.from([0, 255, 1]), {
          headers,
          status: 207,
        }),
    });

    try {
      const response = await app.inject({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        url: "/token",
      });

      expect(response.statusCode).toBe(207);
      expect(response.rawPayload).toEqual(Buffer.from([0, 255, 1]));
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-type"]).toBe("application/octet-stream");
      expect(response.headers["set-cookie"]).toEqual([
        "first=value; Path=/; HttpOnly",
        "second=value; Path=/; Secure",
      ]);
      expect(response.headers["x-observation"]).toBe("one, two");
      expect(hookObservations).toEqual([
        {
          cacheControl: "no-store",
          contentType: "application/octet-stream",
          payloadIsBuffer: true,
          setCookie: ["first=value; Path=/; HttpOnly", "second=value; Path=/; Secure"],
          statusCode: 207,
        },
      ]);
    } finally {
      await app.close();
    }
  });

  it("maps mandatory observations to the request logger and awaits logger acceptance", async () => {
    const error = vi.fn();
    const info = vi.fn();
    const warn = vi.fn();
    const app = Fastify();
    app.addHook("onRequest", async (request) => {
      request.log.error = error;
      request.log.info = info;
      request.log.warn = warn;
    });
    await app.register(githubAppTokenExchangePlugin, {
      tokenExchange: async (_request, context) => {
        await context.observe({
          fields: { event: "issuance_failed", reason: "policy" },
          level: "error",
          message: "Issuance failed",
        });
        await context.observe({
          fields: { event: "issuance_started", repository: "owner/repository" },
          level: "info",
        });
        await context.observe({ fields: { diagnosticCode: "EXAMPLE" }, level: "warn" });
        return new Response(null, { status: 204 });
      },
    });

    try {
      const response = await app.inject({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        url: "/token",
      });

      expect(response.statusCode).toBe(204);
      expect(error).toHaveBeenCalledWith(
        { event: "issuance_failed", reason: "policy" },
        "Issuance failed",
      );
      expect(info).toHaveBeenCalledWith(
        { event: "issuance_started", repository: "owner/repository" },
        "issuance_started",
      );
      expect(warn).toHaveBeenCalledWith({ diagnosticCode: "EXAMPLE" });
    } finally {
      await app.close();
    }
  });

  it("contains optional diagnostic logger failures and returns exactly undefined", async () => {
    const privateLoggerFailure = new Error("private logger failure");
    const warn = vi.fn(() => {
      throw privateLoggerFailure;
    });
    const app = Fastify();
    app.addHook("onRequest", async (request) => {
      request.log.warn = warn;
    });
    await app.register(githubAppTokenExchangePlugin, {
      tokenExchange: async (_request, context) => {
        if (context.observeOidcDiagnostic === undefined) {
          throw new Error("Fastify adapter omitted the optional diagnostic callback");
        }

        const result = context.observeOidcDiagnostic({
          fields: { event: "oidc_document_refresh_failed", issuer: "https://issuer.example" },
          level: "warn",
        });
        expect(result).toBeUndefined();
        return new Response(null, { status: 204 });
      },
    });

    try {
      const response = await app.inject({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        url: "/token",
      });

      expect(response.statusCode).toBe(204);
      expect(warn).toHaveBeenCalledWith(
        { event: "oidc_document_refresh_failed", issuer: "https://issuer.example" },
        "oidc_document_refresh_failed",
      );
    } finally {
      await app.close();
    }
  });

  it("propagates mandatory logger rejection to the handler without returning a token", async () => {
    const privateLoggerFailure = new Error("private-observability-value");
    const app = Fastify();
    app.addHook("onRequest", async (request) => {
      request.log.info = () => {
        throw privateLoggerFailure;
      };
    });
    await app.register(githubAppTokenExchangePlugin, {
      tokenExchange: async (_request, context) => {
        try {
          await context.observe({ fields: { event: "issuance_succeeded" }, level: "info" });
          return Response.json({ access_token: "must-not-escape" });
        } catch (error) {
          expect(error).toBe(privateLoggerFailure);
          return Response.json(
            { error: "server_error" },
            { headers: { "cache-control": "no-store", pragma: "no-cache" }, status: 500 },
          );
        }
      },
    });

    try {
      const response = await app.inject({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        url: "/token",
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "server_error" });
      expect(response.body).not.toContain("must-not-escape");
      expect(response.body).not.toContain("private-observability-value");
    } finally {
      await app.close();
    }
  });

  it("normalizes routed non-POST methods before Fetch request construction", async () => {
    const methods: Array<"DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "PUT" | "TRACE"> = [
      "DELETE",
      "GET",
      "HEAD",
      "OPTIONS",
      "PATCH",
      "PUT",
      "TRACE",
    ];
    const tokenExchange = vi.fn<TokenExchangeHandler>(async () =>
      Response.json({ must_not_reach: true }),
    );
    const app = Fastify();
    await app.register(githubAppTokenExchangePlugin, { tokenExchange });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      for (const method of methods) {
        const response = await makeNodeRequest(`${address}/token`, {
          body: "",
          headers: {},
          method,
        });

        expect(response.statusCode, method).toBe(400);
        expect(response.cacheControl, method).toBe("no-store");
        expect(response.pragma, method).toBe("no-cache");
        if (method !== "HEAD") {
          expect(response.body).toBe('{"error":"invalid_request"}');
        }
      }

      expect(tokenExchange).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("leaves a transport-rejected TRACK request outside the adapter OAuth contract", async () => {
    const tokenExchange = vi.fn<TokenExchangeHandler>();
    const app = Fastify();
    await app.register(githubAppTokenExchangePlugin, { tokenExchange });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      const response = await makeNodeRequest(`${address}/token`, {
        body: "",
        headers: {},
        method: "TRACK",
      });

      expect(response.statusCode).toBe(400);
      expect(response.cacheControl).toBeUndefined();
      expect(tokenExchange).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("bridges request URL, multi-value headers, and exact bounded bytes", async () => {
    const body = "x".repeat(maxTokenExchangeBodyBytes);
    let bridgedRequest: Record<string, unknown> | undefined;
    const tokenExchange = vi.fn<TokenExchangeHandler>(async (request) => {
      bridgedRequest = {
        bodyMatches: (await request.text()) === body,
        clientHint: request.headers.get("x-client-hint"),
        url: request.url,
      };
      return new Response(null, { status: 204 });
    });
    const app = Fastify();
    await app.register(githubAppTokenExchangePlugin, { tokenExchange });

    try {
      const response = await app.inject({
        body,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          host: "broker.example:8443",
          "x-client-hint": ["one", "two"],
        },
        method: "POST",
        url: "/token?trace=one",
      });

      expect(response.statusCode).toBe(204);
      expect(tokenExchange).toHaveBeenCalledOnce();
      expect(bridgedRequest).toEqual({
        bodyMatches: true,
        clientHint: "one,two",
        url: "http://broker.example:8443/token?trace=one",
      });
    } finally {
      await app.close();
    }
  });

  it.each([
    {
      headers: { host: "[" },
      scenario: "malformed Host",
      trustProxy: false,
    },
    {
      headers: { host: "broker.example", "x-forwarded-proto": "not a protocol" },
      scenario: "malformed trusted forwarded protocol",
      trustProxy: true,
    },
    {
      headers: { host: "user:pass@example.com" },
      scenario: "password-bearing Host",
      trustProxy: false,
    },
    {
      headers: { host: "user@example.com" },
      scenario: "username-bearing Host",
      trustProxy: false,
    },
  ])("sanitizes $scenario before token exchange", async ({ headers, trustProxy }) => {
    const tokenExchange = vi.fn<TokenExchangeHandler>();
    const app = Fastify({ trustProxy });
    await app.register(githubAppTokenExchangePlugin, { tokenExchange });

    try {
      const response = await app.inject({
        headers: {
          ...headers,
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
        url: "/token",
      });

      expectOAuthInvalidRequest(response, 400);
      expect(tokenExchange).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("lets host admission reject before body parsing and token exchange", async () => {
    const tokenExchange = vi.fn<TokenExchangeHandler>();
    const app = Fastify();
    app.addHook("onRequest", async (_request, reply) => {
      await reply.code(429).send({ error: "host_rate_limit" });
    });
    await app.register(githubAppTokenExchangePlugin, { tokenExchange });

    try {
      const response = await app.inject({
        body: "x".repeat(maxTokenExchangeBodyBytes + 1),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        url: "/token",
      });

      expect(response.statusCode).toBe(429);
      expect(response.json()).toEqual({ error: "host_rate_limit" });
      expect(tokenExchange).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rethrows an unrecognized handler error unchanged to the parent error handler", async () => {
    const sentinel = new Error("host-owned-failure");
    let parentError: unknown;
    const app = Fastify();
    app.setErrorHandler(async (error, _request, reply) => {
      parentError = error;
      await reply.code(598).send({ error: "host_error" });
    });
    await app.register(githubAppTokenExchangePlugin, {
      tokenExchange: async () => Promise.reject(sentinel),
    });

    try {
      const response = await app.inject({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        url: "/token",
      });

      expect(response.statusCode).toBe(598);
      expect(response.json()).toEqual({ error: "host_error" });
      expect(parentError).toBe(sentinel);
    } finally {
      await app.close();
    }
  });

  it("translates duplicate headers and raw form bytes over a real loopback socket", async () => {
    const observed: Array<Record<string, unknown>> = [];
    const app = Fastify();
    const responseHeaders = new Headers({ "cache-control": "no-store", pragma: "no-cache" });
    responseHeaders.append("set-cookie", "socket=value; Path=/; HttpOnly");
    await app.register(githubAppTokenExchangePlugin, {
      prefix: "/automation",
      tokenExchange: async (request) => {
        observed.push({
          body: await request.text(),
          clientHint: request.headers.get("x-client-hint"),
          url: request.url,
        });
        return Response.json({ ok: true }, { headers: responseHeaders });
      },
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      const response = await makeNodeRequest(`${address}/automation/token?transport=socket`, {
        body: "scope=contents%3Aread&scope=actions%3Awrite",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-client-hint": ["one", "two"],
        },
      });

      expect(response).toEqual({
        body: '{"ok":true}',
        cacheControl: "no-store",
        pragma: "no-cache",
        setCookie: ["socket=value; Path=/; HttpOnly"],
        statusCode: 200,
      });
      expect(observed).toEqual([
        {
          body: "scope=contents%3Aread&scope=actions%3Awrite",
          clientHint: "one, two",
          url: `${address}/automation/token?transport=socket`,
        },
      ]);
    } finally {
      await app.close();
    }
  });
});

function expectOAuthInvalidRequest(
  response: {
    headers: Record<string, number | string | string[] | undefined>;
    json(): unknown;
    statusCode: number;
  },
  status: 400 | 413,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.json()).toEqual({ error: "invalid_request" });
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["pragma"]).toBe("no-cache");
}

async function makeNodeRequest(
  url: string,
  input: {
    readonly body: string;
    readonly headers: Readonly<Record<string, string | string[]>>;
    readonly method?: string;
  },
): Promise<{
  body: string;
  cacheControl: string | undefined;
  pragma: string | undefined;
  setCookie: string[] | undefined;
  statusCode: number | undefined;
}> {
  return new Promise((resolve, reject) => {
    const request = nodeHttpRequest(
      url,
      { headers: input.headers, method: input.method ?? "POST" },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            cacheControl:
              typeof response.headers["cache-control"] === "string"
                ? response.headers["cache-control"]
                : undefined,
            pragma:
              typeof response.headers["pragma"] === "string"
                ? response.headers["pragma"]
                : undefined,
            setCookie: response.headers["set-cookie"],
            statusCode: response.statusCode,
          });
        });
      },
    );
    request.on("error", reject);
    request.end(input.body);
  });
}
