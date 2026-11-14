import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import { githubAppTokenExchangePlugin } from "@github-app-token-broker/fastify";
import type { GitHubAppTokenExchangeHandler } from "@github-app-token-broker/core";
import { describe, expect, it, vi } from "vitest";

const path = "/github/apps/fixture-app/token";

describe("Fastify Token Exchange lifetime", () => {
  it("does not treat normal request completion as a client disconnect", async () => {
    let signal: AbortSignal | undefined;
    const app = await listen(async (request) => {
      signal = request.signal;
      await delay(10);
      expect(signal.aborted).toBe(false);
      return Response.json({ ok: true });
    });
    try {
      const response = await fetch(`${app.address}${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "fixture=body",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(signal?.aborted).toBe(false);
    } finally {
      await app.server.close();
    }
  });

  it("signals an actual disconnect while asynchronous exchange work is pending", async () => {
    const started = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    const app = await listen(async (request) => {
      started.resolve(request.signal);
      await release.promise;
      return Response.json({ ok: true });
    });
    const client = httpRequest(`${app.address}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    client.on("error", () => undefined);
    client.end("fixture=body");
    try {
      const signal = await started.promise;
      const cancelled = Promise.withResolvers<void>();
      signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
      client.destroy();
      await Promise.race([
        cancelled.promise,
        delay(1000).then(() => {
          throw new Error("disconnect did not cancel exchange");
        }),
      ]);
      expect(signal.aborted).toBe(true);
    } finally {
      release.resolve();
      client.destroy();
      await app.server.close();
    }
  });

  it("bounds stalled body acquisition and accepts the next request on the same listener", async () => {
    const accepted = Promise.withResolvers<void>();
    const exchange = vi.fn(async () => Response.json({ ok: true }));
    const app = await listen(exchange, () => accepted.resolve());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const client = httpRequest(`${app.address}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": "100",
      },
    });
    client.on("error", () => undefined);
    let responseStatus: number | undefined;
    let responseBody = "";
    const responseFinished = Promise.withResolvers<void>();
    client.on("response", (response) => {
      responseStatus = response.statusCode;
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        responseBody += chunk;
      });
      response.on("end", () => responseFinished.resolve());
    });
    client.write("fixture=");
    try {
      await accepted.promise;
      await delay(10);
      await vi.advanceTimersByTimeAsync(45_000);
      await Promise.race([
        responseFinished.promise,
        delay(1000).then(() => {
          throw new Error("body deadline did not complete a response");
        }),
      ]);
      expect(responseStatus).toBe(503);
      expect(JSON.parse(responseBody)).toEqual({ error: "temporarily_unavailable" });
      expect(exchange).not.toHaveBeenCalled();
      vi.useRealTimers();
      const next = await fetch(`${app.address}${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "fixture=body",
      });
      expect(next.status).toBe(200);
      expect(await next.json()).toEqual({ ok: true });
      expect(exchange).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      client.destroy();
      await app.server.close();
    }
  });

  it("keeps the original budget when body acquisition finishes", async () => {
    const accepted = Promise.withResolvers<void>();
    const started = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    const app = await listen(
      async (request) => {
        started.resolve(request.signal);
        await release.promise;
        return Response.json({ ok: true });
      },
      () => accepted.resolve(),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const client = httpRequest(`${app.address}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    client.on("error", () => undefined);
    client.write("fixture=");
    try {
      await accepted.promise;
      await delay(10);
      await vi.advanceTimersByTimeAsync(30_000);
      client.end("body");
      const signal = await started.promise;
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
      release.resolve();
      client.destroy();
      await app.server.close();
    }
  });
});

async function listen(handler: (request: Request) => Promise<Response>, onRequest?: () => void) {
  const server = Fastify();
  if (onRequest !== undefined) server.addHook("onRequest", async () => onRequest());
  const tokenExchange: GitHubAppTokenExchangeHandler = Object.assign(handler, {
    tokenEndpointPaths: [path],
  });
  await server.register(githubAppTokenExchangePlugin, { tokenExchange });
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  return { address, server };
}
