import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { createTokenExchangeWorker } from "@github-app-token-broker/worker";
import { describe, expect, it, vi } from "vitest";
import { githubActionsTokenExchangeRequest } from "./support/github-actions-token-exchange.ts";
import { testNow } from "./support/constants.ts";
import { fetchGitHubActionsTokenExchangeExternalTestDouble } from "./support/github-actions-token-exchange.ts";
import { testEnv, testGitHubActionsTokenExchangeComposition } from "./support/worker.ts";

describe("Worker Token Exchange lifetime", () => {
  it("bounds stalled admission without starting upstream work", async () => {
    const admission = Promise.withResolvers<{ success: boolean }>();
    const entered = Promise.withResolvers<void>();
    const fetchExternal = vi.fn<typeof fetch>();
    const worker = createTokenExchangeWorker(testGitHubActionsTokenExchangeComposition, {
      fetch: fetchExternal,
      now: () => testNow,
      observe: async () => undefined,
    });
    const request = await githubActionsTokenExchangeRequest();
    const context = createExecutionContext();
    vi.useFakeTimers();
    let settled = false;
    const pending = Promise.resolve(
      worker.fetch!(
        request as Parameters<NonNullable<typeof worker.fetch>>[0],
        {
          ...testEnv,
          TOKEN_EXCHANGE_RATE_LIMIT: {
            limit: () => {
              entered.resolve();
              return admission.promise;
            },
          },
        },
        context,
      ),
    ).then((response) => {
      settled = true;
      return response;
    });
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(45_000);
      expect(settled).toBe(true);
      const response = await pending;
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "temporarily_unavailable" });
      expect(fetchExternal).not.toHaveBeenCalled();
      admission.resolve({ success: true });
      await Promise.resolve();
      expect(fetchExternal).not.toHaveBeenCalled();
    } finally {
      admission.resolve({ success: false });
      await pending;
      await waitOnExecutionContext(context);
      vi.useRealTimers();
    }
  });

  it("retains in-flight mint recovery in the execution context after disconnect", async () => {
    const mintStarted = Promise.withResolvers<void>();
    const mint = Promise.withResolvers<Response>();
    const methods: string[] = [];
    const worker = createTokenExchangeWorker(testGitHubActionsTokenExchangeComposition, {
      now: () => testNow,
      observe: async () => undefined,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).hostname === "api.github.com") {
          methods.push(request.method);
          if (request.method === "POST") {
            mintStarted.resolve();
            return mint.promise;
          }
          if (request.method === "DELETE") return new Response(null, { status: 204 });
        }
        return fetchGitHubActionsTokenExchangeExternalTestDouble(request);
      },
    });
    const disconnect = new AbortController();
    const request = new Request(await githubActionsTokenExchangeRequest(), {
      signal: disconnect.signal,
    });
    const context = createExecutionContext();
    const pending = Promise.resolve(
      worker.fetch!(request as Parameters<NonNullable<typeof worker.fetch>>[0], testEnv, context),
    );
    try {
      await mintStarted.promise;
      disconnect.abort();
      let drained = false;
      const drain = waitOnExecutionContext(context).then(() => {
        drained = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(drained).toBe(false);
      mint.resolve(
        Response.json(
          {
            token: "synthetic-recovery-token",
            expires_at: "2030-01-01T00:00:00Z",
            permissions: { contents: "write", pull_requests: "write" },
          },
          { status: 201 },
        ),
      );
      const response = await pending;
      expect(response.status).toBe(503);
      await drain;
      expect(methods).toEqual(["GET", "POST", "DELETE"]);
    } finally {
      mint.resolve(
        Response.json(
          {
            token: "synthetic-recovery-token",
            expires_at: "2030-01-01T00:00:00Z",
            permissions: { contents: "write", pull_requests: "write" },
          },
          { status: 201 },
        ),
      );
      await pending;
      await waitOnExecutionContext(context);
    }
  });

  it("retains shared authentication after the canceled request has returned", async () => {
    const authenticationStarted = Promise.withResolvers<void>();
    const resumeAuthentication = Promise.withResolvers<void>();
    const worker = createTokenExchangeWorker(testGitHubActionsTokenExchangeComposition, {
      now: () => testNow,
      observe: async () => undefined,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/.well-known/openid-configuration")) {
          authenticationStarted.resolve();
          await resumeAuthentication.promise;
        }
        return fetchGitHubActionsTokenExchangeExternalTestDouble(request);
      },
    });
    const disconnect = new AbortController();
    const request = new Request(await githubActionsTokenExchangeRequest(), {
      signal: disconnect.signal,
    });
    const context = createExecutionContext();
    const pending = Promise.resolve(
      worker.fetch!(request as Parameters<NonNullable<typeof worker.fetch>>[0], testEnv, context),
    );
    try {
      await authenticationStarted.promise;
      disconnect.abort();
      const response = await pending;
      expect(response.status).toBe(503);
      let drained = false;
      const drain = waitOnExecutionContext(context).then(() => {
        drained = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(drained).toBe(false);
      resumeAuthentication.resolve();
      await drain;
    } finally {
      resumeAuthentication.resolve();
      await pending;
      await waitOnExecutionContext(context);
    }
  });
});
