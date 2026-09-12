import * as z from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchGitHubApiJson,
  GitHubApiError,
  GitHubApiTransportError,
  revokeGitHubInstallationAccessToken,
} from "../src/http.ts";

const responseSchema = z.object({ value: z.string() });
const requestPath = "/test/response";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GitHub API HTTP adapter", () => {
  it("revokes an Installation Access Token at the fixed GitHub API endpoint", async () => {
    const fetchGitHub = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toEqual(new URL("https://api.github.com/installation/token"));
      expect(init?.method).toBe("DELETE");
      expect(init?.redirect).toBe("manual");
      expect(init?.body).toBeUndefined();

      const headers = new Headers(init?.headers);
      expect(headers.get("accept")).toBe("application/vnd.github+json");
      expect(headers.get("authorization")).toBe("Bearer ghs_token_to_revoke");
      expect(headers.get("user-agent")).toBe("github-app-token-broker");
      expect(headers.get("x-github-api-version")).toBe("2022-11-28");

      return new Response(null, { status: 204 });
    });

    await expect(
      revokeGitHubInstallationAccessToken({ fetch: fetchGitHub }, "ghs_token_to_revoke"),
    ).resolves.toBeUndefined();
    expect(fetchGitHub).toHaveBeenCalledOnce();
  });

  it.each([200, 302, 503])("rejects revocation response status %s", async (status) => {
    const cancel = vi.fn();
    const fetchGitHub = vi.fn<typeof fetch>(
      async () =>
        new Response(new ReadableStream<Uint8Array>({ cancel }), {
          ...(status === 302 ? { headers: { location: "https://attacker.example/token" } } : {}),
          status,
        }),
    );

    await expect(
      revokeGitHubInstallationAccessToken({ fetch: fetchGitHub }, "ghs_token_to_revoke"),
    ).rejects.toBeInstanceOf(GitHubApiError);
    expect(fetchGitHub).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds Installation Access Token revocation with the fixed GitHub deadline", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let requestSignal: AbortSignal | null | undefined;
    const result = revokeGitHubInstallationAccessToken(
      {
        fetch: async (_input, init) => {
          requestSignal = init?.signal;

          return new Promise<Response>(() => undefined);
        },
      },
      "ghs_token_to_revoke",
    );

    deadline.abort(new DOMException("private timeout detail", "TimeoutError"));

    await expect(result).rejects.toBeInstanceOf(GitHubApiTransportError);
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(requestSignal?.aborted).toBe(true);
  });

  it("uses the fixed GitHub API origin, merges headers, and parses a valid response", async () => {
    const response = Response.json({ value: "parsed" });
    const fetchGitHub = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toEqual(new URL("https://api.github.com/test/response"));
      expect(init?.method).toBe("GET");

      const headers = new Headers(init?.headers);
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("x-request-id")).toBe("fixture");

      return response;
    });

    await expect(
      fetchGitHubApiJson(
        { fetch: fetchGitHub },
        {
          headers: { accept: "application/json" },
          init: { headers: { "x-request-id": "fixture" }, method: "GET" },
          path: requestPath,
          responseSchema,
        },
      ),
    ).resolves.toEqual({ value: "parsed" });
    expect(fetchGitHub).toHaveBeenCalledOnce();
    expect(response.bodyUsed).toBe(true);
    expect(response.body?.locked).toBe(false);
  });

  it("preserves the transport failure when an upstream response body is already locked", async () => {
    const response = new Response(finiteBody(new TextEncoder().encode("private response")));
    const reader = response.body?.getReader();

    try {
      await expect(
        fetchGitHubApiJson(
          { fetch: async () => response },
          { headers: {}, path: requestPath, responseSchema },
        ),
      ).rejects.toMatchObject({
        message: `GitHub API request failed: ${requestPath}`,
        name: "GitHubApiTransportError",
        upstreamStatus: 200,
      });
      await expect(reader?.read()).resolves.toEqual({
        done: false,
        value: new TextEncoder().encode("private response"),
      });
    } finally {
      await reader?.cancel();
      reader?.releaseLock();
    }
  });

  it("forces manual redirect handling so App credentials are never forwarded", async () => {
    const fetchGitHub = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toEqual(new URL("https://api.github.com/test/response"));
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-app-jwt");

      return new Response(null, {
        headers: { location: "https://attacker.example/credential-target" },
        status: 302,
      });
    });

    await expect(
      fetchGitHubApiJson(
        { fetch: fetchGitHub },
        {
          headers: { authorization: "Bearer private-app-jwt" },
          init: { redirect: "follow" },
          path: requestPath,
          responseSchema,
        },
      ),
    ).rejects.toMatchObject({
      status: 302,
      upstreamStatus: 302,
    });
    expect(fetchGitHub).toHaveBeenCalledOnce();
  });

  it.each(["https://attacker.example/private", "//attacker.example/private", "/\\attacker"])(
    "rejects the unsafe API path %s before forwarding credentials",
    async (path) => {
      const fetchGitHub = vi.fn<typeof fetch>();

      await expect(
        fetchGitHubApiJson(
          { fetch: fetchGitHub },
          {
            headers: { authorization: "Bearer private-app-jwt" },
            path,
            responseSchema,
          },
        ),
      ).rejects.toBeInstanceOf(GitHubApiTransportError);
      expect(fetchGitHub).not.toHaveBeenCalled();
    },
  );

  it.each([
    { headers: {}, rateLimited: false, status: 400, scenario: "a bad request" },
    { headers: {}, rateLimited: false, status: 403, scenario: "an ordinary forbidden response" },
    { headers: {}, rateLimited: false, status: 404, scenario: "a missing resource" },
    { headers: {}, rateLimited: false, status: 500, scenario: "a server failure" },
    { headers: {}, rateLimited: true, status: 429, scenario: "a rate limit response" },
    {
      headers: { "x-ratelimit-remaining": "0" },
      rateLimited: true,
      status: 403,
      scenario: "a primary rate limit",
    },
    {
      headers: { "retry-after": "60" },
      rateLimited: true,
      status: 403,
      scenario: "a retry-after rate limit",
    },
    {
      body: JSON.stringify({ message: "You have exceeded a secondary rate limit." }),
      headers: {},
      rateLimited: true,
      status: 403,
      scenario: "a secondary rate limit body",
    },
  ])(
    "classifies $scenario without exposing the response body",
    async ({ body, headers, rateLimited, status }) => {
      const error = fetchGitHubApiJson(
        {
          fetch: async () => new Response(body ?? "private upstream detail", { headers, status }),
        },
        { headers: {}, path: requestPath, responseSchema },
      );

      await expect(error).rejects.toBeInstanceOf(GitHubApiError);
      await expect(error).rejects.toMatchObject({
        message: `GitHub API request failed: ${requestPath}`,
        rateLimited,
        status,
        upstreamStatus: status,
      });
    },
  );

  it("does not mistake an oversized forbidden body for a rate limit", async () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        message: `You have exceeded a secondary rate limit ${"x".repeat(16 * 1024)}`,
      }),
    );

    await expect(
      fetchGitHubApiJson(
        { fetch: async () => new Response(finiteBody(body), { status: 403 }) },
        { headers: {}, path: requestPath, responseSchema },
      ),
    ).rejects.toMatchObject({ rateLimited: false, status: 403 });
  });

  it("classifies an unreadable forbidden body as an ordinary upstream failure", async () => {
    await expect(
      fetchGitHubApiJson(
        { fetch: async () => new Response(unreadableBody(), { status: 403 }) },
        { headers: {}, path: requestPath, responseSchema },
      ),
    ).rejects.toMatchObject({ rateLimited: false, status: 403 });
  });

  it.each([
    { headers: {}, rateLimited: false, status: 403 },
    { headers: { "x-ratelimit-remaining": "0" }, rateLimited: true, status: 403 },
    { headers: { "retry-after": "60" }, rateLimited: true, status: 403 },
    { headers: {}, rateLimited: true, status: 429 },
  ])(
    "uses only status and headers as rate-limit evidence when JSON contains malformed UTF-8: $status $headers",
    async ({ headers, rateLimited, status }) => {
      const body = Uint8Array.of(
        ...new TextEncoder().encode('{"message":"rate limit '),
        0xff,
        ...new TextEncoder().encode('"}'),
      );

      await expect(
        fetchGitHubApiJson(
          { fetch: async () => new Response(body, { headers, status }) },
          { headers: {}, path: requestPath, responseSchema },
        ),
      ).rejects.toMatchObject({
        message: `GitHub API request failed: ${requestPath}`,
        rateLimited,
        status,
        upstreamStatus: status,
      });
    },
  );

  it("classifies a status-only rate limit before reading its body", async () => {
    const response = new Response(unreadableBody(), { status: 429 });

    await expect(
      fetchGitHubApiJson(
        { fetch: async () => response },
        { headers: {}, path: requestPath, responseSchema },
      ),
    ).rejects.toMatchObject({ rateLimited: true, status: 429 });
  });

  it.each([
    { headers: {}, rateLimited: false, status: 302 },
    { headers: {}, rateLimited: false, status: 404 },
    { headers: {}, rateLimited: false, status: 503 },
    { headers: {}, rateLimited: true, status: 429 },
    { headers: { "x-ratelimit-remaining": "0" }, rateLimited: true, status: 403 },
    { headers: { "retry-after": "60" }, rateLimited: true, status: 403 },
  ])(
    "discards a header-classified $status body without waiting for cancellation",
    async ({ headers, rateLimited, status }) => {
      const cancellation = Promise.withResolvers<void>();
      const cancel = vi.fn(() => cancellation.promise);
      const pull = vi.fn();
      const response = new Response(
        new ReadableStream<Uint8Array>({ cancel, pull }, { highWaterMark: 0 }),
        { headers, status },
      );

      try {
        await expect(
          fetchGitHubApiJson(
            { fetch: async () => response },
            { headers: {}, path: requestPath, responseSchema },
          ),
        ).rejects.toMatchObject({ rateLimited, status, upstreamStatus: status });
        expect(cancel).toHaveBeenCalledOnce();
        expect(pull).not.toHaveBeenCalled();
      } finally {
        cancellation.resolve();
        await response.body?.cancel();
      }
    },
  );

  it.each(["throws", "rejects"] as const)(
    "preserves the GitHub failure when response cancellation $0",
    async (failure) => {
      const body = new ReadableStream<Uint8Array>();
      const cancel = vi.spyOn(body, "cancel").mockImplementation(() => {
        const error = new Error("private response cancellation failure");
        if (failure === "throws") {
          throw error;
        }

        return Promise.reject(error);
      });

      try {
        await expect(
          fetchGitHubApiJson(
            { fetch: async () => new Response(body, { status: 503 }) },
            { headers: {}, path: requestPath, responseSchema },
          ),
        ).rejects.toMatchObject({
          message: `GitHub API request failed: ${requestPath}`,
          rateLimited: false,
          status: 503,
          upstreamStatus: 503,
        });
        expect(cancel).toHaveBeenCalledOnce();
      } finally {
        cancel.mockRestore();
        await body.cancel();
      }
    },
  );

  it.each([
    ["malformed JSON", new Response("{"), 200],
    [
      "JSON containing malformed UTF-8",
      new Response(
        Uint8Array.of(
          ...new TextEncoder().encode('{"value":"'),
          0xff,
          ...new TextEncoder().encode('"}'),
        ),
      ),
      200,
    ],
    ["a schema-invalid response", Response.json({ value: 123 }), 200],
    ["an oversized successful response", Response.json({ value: "x".repeat(128 * 1024) }), 200],
  ] as const)("rejects %s as an invalid upstream response", async (_scenario, response, status) => {
    await expect(
      fetchGitHubApiJson(
        { fetch: async () => response },
        { headers: {}, path: requestPath, responseSchema },
      ),
    ).rejects.toMatchObject({
      message: `GitHub API returned an invalid response: ${requestPath}`,
      status: 502,
      upstreamStatus: status,
    });
  });

  it("classifies response-body failures and fetch failures as transport errors", async () => {
    const unreadableResponse = new Response(unreadableBody());

    await expect(
      fetchGitHubApiJson(
        { fetch: async () => unreadableResponse },
        { headers: {}, path: requestPath, responseSchema },
      ),
    ).rejects.toBeInstanceOf(GitHubApiTransportError);
    await expect(
      fetchGitHubApiJson(
        { fetch: async () => new Response(unreadableBody(), { status: 201 }) },
        { headers: {}, path: requestPath, responseSchema },
      ),
    ).rejects.toMatchObject({ upstreamStatus: 201 });
    await expect(
      fetchGitHubApiJson(
        {
          fetch: async () => {
            throw new Error("private network failure");
          },
        },
        { headers: {}, path: requestPath, responseSchema },
      ),
    ).rejects.toMatchObject({ name: "GitHubApiTransportError", upstreamStatus: undefined });
  });

  it("applies one fixed broker deadline while waiting for response headers", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let requestSignal: AbortSignal | null | undefined;
    const result = fetchGitHubApiJson(
      {
        fetch: async (_input, init) => {
          requestSignal = init?.signal;

          return new Promise<Response>(() => undefined);
        },
      },
      { headers: {}, path: requestPath, responseSchema },
    );

    deadline.abort(new DOMException("private timeout detail", "TimeoutError"));

    await expect(result).rejects.toMatchObject({
      message: `GitHub API request failed: ${requestPath}`,
      name: "GitHubApiTransportError",
      upstreamStatus: undefined,
    });
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(requestSignal?.aborted).toBe(true);
  });

  it.each(["before failure is observed", "after failure is observed"] as const)(
    "discards a response received after the deadline $0 without changing the failure evidence",
    async (settlement) => {
      const deadline = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
      const upstream = Promise.withResolvers<Response>();
      const cancel = vi.fn();
      const pull = vi.fn();
      const lateResponse = new Response(
        new ReadableStream<Uint8Array>({ cancel, pull }, { highWaterMark: 0 }),
        { status: 201 },
      );
      const result = fetchGitHubApiJson(
        { fetch: () => upstream.promise },
        { headers: {}, path: requestPath, responseSchema },
      );
      const expectedFailure = {
        message: `GitHub API request failed: ${requestPath}`,
        name: "GitHubApiTransportError",
        upstreamStatus: undefined,
      };

      try {
        deadline.abort(new DOMException("private timeout detail", "TimeoutError"));
        if (settlement === "before failure is observed") {
          upstream.resolve(lateResponse);
        }
        await expect(result).rejects.toMatchObject(expectedFailure);
        upstream.resolve(lateResponse);
        await upstream.promise;

        expect(cancel).toHaveBeenCalledOnce();
        expect(pull).not.toHaveBeenCalled();
        await expect(result).rejects.toMatchObject(expectedFailure);
      } finally {
        upstream.resolve(lateResponse);
        await lateResponse.body?.cancel();
      }
    },
  );

  it("composes a caller abort with the broker deadline", async () => {
    const caller = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    const result = fetchGitHubApiJson(
      {
        fetch: async (_input, init) => {
          requestSignal = init?.signal;

          return new Promise<Response>(() => undefined);
        },
      },
      {
        headers: {},
        init: { signal: caller.signal },
        path: requestPath,
        responseSchema,
      },
    );

    caller.abort(new DOMException("private caller detail", "AbortError"));

    await expect(result).rejects.toMatchObject({
      message: `GitHub API request failed: ${requestPath}`,
      name: "GitHubApiTransportError",
      upstreamStatus: undefined,
    });
    expect(requestSignal).not.toBe(caller.signal);
    expect(requestSignal?.aborted).toBe(true);
  });

  it.each([
    { status: 200, scenario: "a successful response" },
    {
      status: 403,
      scenario: "a forbidden error response",
    },
  ])("enforces the deadline and cancels the reader for $scenario body", async ({ status }) => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const cancel = vi.fn();
    let markReadStarted: () => void = () => undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const upstreamResponse = new Response(
      new ReadableStream<Uint8Array>(
        {
          cancel,
          pull: () => {
            markReadStarted();

            return new Promise<void>(() => undefined);
          },
        },
        { highWaterMark: 0 },
      ),
      { status },
    );
    const result = fetchGitHubApiJson(
      { fetch: async () => upstreamResponse },
      { headers: {}, path: requestPath, responseSchema },
    );

    await readStarted;
    deadline.abort(new DOMException("private body timeout detail", "TimeoutError"));

    await expect(result).rejects.toMatchObject({
      message: `GitHub API request failed: ${requestPath}`,
      name: "GitHubApiTransportError",
      upstreamStatus: status,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

function finiteBody(body: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  });
}

function unreadableBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("private response stream failure"));
    },
  });
}
