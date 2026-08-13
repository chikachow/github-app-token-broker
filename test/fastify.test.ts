import formbody from "@fastify/formbody";
import { githubAppTokenExchangePlugin } from "@github-app-token-broker/fastify";
import type {
  TokenExchangeEvent,
  TokenExchangeHandler,
} from "@github-app-token-broker/token-exchange";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

describe("githubAppTokenExchangePlugin", () => {
  it("preserves raw form bytes and duplicate fields when an ancestor uses formbody", async () => {
    const tokenExchange = vi.fn<TokenExchangeHandler>(async (request) => {
      expect(request.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
      expect(await request.text()).toBe("scope=&scope=contents%3Aread&scope=actions%3Awrite");
      return oauthResponse(200, { ok: true });
    });
    const app = Fastify();
    await app.register(formbody);
    app.post("/ordinary-form", async (request) => request.body);
    await app.register(githubAppTokenExchangePlugin, { prefix: "/automation", tokenExchange });

    try {
      const response = await app.inject({
        body: "scope=&scope=contents%3Aread&scope=actions%3Awrite",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        url: "/automation/token",
      });

      expect(response.statusCode).toBe(200);
      expect(tokenExchange).toHaveBeenCalledOnce();
      expect((await app.inject({ method: "POST", url: "/token" })).statusCode).toBe(404);
      const ordinaryResponse = await app.inject({
        body: "field=value",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        url: "/ordinary-form",
      });
      expect(ordinaryResponse.json()).toEqual({ field: "value" });
    } finally {
      await app.close();
    }
  });

  it("translates an actual Node request and response over a listening socket", async () => {
    const app = Fastify();
    await app.register(githubAppTokenExchangePlugin, {
      tokenExchange: async (request) =>
        oauthResponse(200, {
          contentType: request.headers.get("content-type"),
          rawBody: await request.text(),
        }),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      const response = await fetch(`${address}/token`, {
        body: "scope=contents%3Aread&scope=actions%3Awrite",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({
        contentType: "application/x-www-form-urlencoded",
        rawBody: "scope=contents%3Aread&scope=actions%3Awrite",
      });
    } finally {
      await app.close();
    }
  });

  it.each(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "PUT"] as const)(
    "delegates the OAuth method contract for %s to the core handler",
    async (method) => {
      const tokenExchange = vi.fn<TokenExchangeHandler>(async (request) =>
        oauthResponse(400, { error: request.method }),
      );
      const app = Fastify();
      await app.register(githubAppTokenExchangePlugin, { tokenExchange });

      try {
        const response = await app.inject({ method, url: "/token" });

        expect(response.statusCode).toBe(400);
        expect(tokenExchange).toHaveBeenCalledOnce();
      } finally {
        await app.close();
      }
    },
  );

  it.each([
    { contentType: undefined, scenario: "missing" },
    { contentType: "application/json", scenario: "unsupported" },
    { contentType: "not a type", scenario: "malformed" },
  ])("returns the core OAuth error for $scenario content type", async ({ contentType }) => {
    const tokenExchange = vi.fn<TokenExchangeHandler>(async () =>
      oauthResponse(400, { error: "invalid_request" }),
    );
    const app = Fastify();
    await app.register(githubAppTokenExchangePlugin, { tokenExchange });

    try {
      const response = await app.inject({
        body: "grant_type=ignored",
        ...(contentType === undefined ? {} : { headers: { "content-type": contentType } }),
        method: "POST",
        url: "/token",
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid_request" });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(tokenExchange).toHaveBeenCalledTimes(contentType === "not a type" ? 0 : 1);
    } finally {
      await app.close();
    }
  });

  it("normalizes parser body-limit errors to the OAuth contract", async () => {
    const tokenExchange = vi.fn<TokenExchangeHandler>();
    const app = Fastify();
    await app.register(githubAppTokenExchangePlugin, { tokenExchange });

    try {
      const response = await app.inject({
        body: "x".repeat(64 * 1024 + 1),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        url: "/token",
      });

      expect(response.statusCode).toBe(413);
      expect(response.json()).toEqual({ error: "invalid_request" });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(tokenExchange).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("makes copied response metadata visible to Fastify hooks", async () => {
    const hookObservations: Array<Record<string, unknown>> = [];
    const app = Fastify();
    app.addHook("onSend", async (_request, reply, payload) => {
      hookObservations.push({
        cacheControl: reply.getHeader("cache-control"),
        contentType: reply.getHeader("content-type"),
        payloadIsBuffer: Buffer.isBuffer(payload),
        statusCode: reply.statusCode,
      });
      return payload;
    });
    await app.register(githubAppTokenExchangePlugin, {
      tokenExchange: async () => oauthResponse(401, { error: "invalid_client" }),
    });

    try {
      await app.inject({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        url: "/token",
      });
      expect(hookObservations).toContainEqual({
        cacheControl: "no-store",
        contentType: "application/json",
        payloadIsBuffer: true,
        statusCode: 401,
      });
    } finally {
      await app.close();
    }
  });

  it("maps sanitized observations to request logging without overriding Pino level", async () => {
    const logMethod = vi.fn();
    const app = Fastify();
    app.addHook("onRequest", async (request) => {
      request.log.warn = logMethod;
    });
    const event = {
      diagnosticCode: "ERR_JWT_INVALID",
      event: "oidc_authentication_failed",
      level: "warn",
      path: "/token",
      reason: "invalid_token",
      userAgent: null,
    } satisfies TokenExchangeEvent;
    await app.register(githubAppTokenExchangePlugin, {
      tokenExchange: async (_request, context) => {
        context.observe(event);
        return oauthResponse(400, { error: "invalid_request" });
      },
    });

    try {
      await app.inject({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        url: "/token",
      });
      expect(logMethod).toHaveBeenCalledWith(
        expect.objectContaining({
          diagnosticCode: "ERR_JWT_INVALID",
          event: "oidc_authentication_failed",
          requestId: expect.any(String),
        }),
        "oidc_authentication_failed",
      );
      expect(logMethod.mock.calls[0]?.[0]).not.toHaveProperty("level");
    } finally {
      await app.close();
    }
  });

  it("leaves host admission control outside the plugin and ahead of body parsing", async () => {
    const tokenExchange = vi.fn<TokenExchangeHandler>();
    const app = Fastify();
    app.addHook("onRequest", async (_request, reply) => {
      await reply.code(429).send({ error: "host_rate_limit" });
    });
    await app.register(githubAppTokenExchangePlugin, { tokenExchange });

    try {
      const response = await app.inject({
        body: "x".repeat(64 * 1024 + 1),
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
});

function oauthResponse(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, {
    headers: { "cache-control": "no-store", pragma: "no-cache" },
    status,
  });
}
