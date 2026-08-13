import * as z from "zod";
import { describe, expect, it, vi } from "vitest";

import { fetchGitHubApiJson, GitHubApiError, GitHubApiTransportError } from "../src/http.ts";

const responseSchema = z.object({ value: z.string() });
const requestPath = "/test/response";

describe("GitHub API HTTP adapter", () => {
  it("builds the request URL, merges headers, and parses a valid response", async () => {
    const fetchGitHub = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toEqual(new URL("https://api.github.test/base/test/response"));
      expect(init?.method).toBe("GET");

      const headers = new Headers(init?.headers);
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("x-request-id")).toBe("fixture");

      return Response.json({ value: "parsed" });
    });

    await expect(
      fetchGitHubApiJson(
        { apiBaseUrl: "https://api.github.test/base" },
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
  });

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
        {},
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
        {},
        { fetch: async () => new Response(finiteBody(body), { status: 403 }) },
        { headers: {}, path: requestPath, responseSchema },
      ),
    ).rejects.toMatchObject({ rateLimited: false, status: 403 });
  });

  it("classifies an unreadable forbidden body as an ordinary upstream failure", async () => {
    await expect(
      fetchGitHubApiJson(
        {},
        { fetch: async () => new Response(unreadableBody(), { status: 403 }) },
        { headers: {}, path: requestPath, responseSchema },
      ),
    ).rejects.toMatchObject({ rateLimited: false, status: 403 });
  });

  it("classifies a status-only rate limit before reading its body", async () => {
    const response = new Response(unreadableBody(), { status: 429 });

    await expect(
      fetchGitHubApiJson(
        {},
        { fetch: async () => response },
        { headers: {}, path: requestPath, responseSchema },
      ),
    ).rejects.toMatchObject({ rateLimited: true, status: 429 });
  });

  it.each([
    ["malformed JSON", new Response("{"), 200],
    ["a schema-invalid response", Response.json({ value: 123 }), 200],
    ["an oversized successful response", Response.json({ value: "x".repeat(128 * 1024) }), 200],
  ] as const)("rejects %s as an invalid upstream response", async (_scenario, response, status) => {
    await expect(
      fetchGitHubApiJson(
        {},
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
    const unreadableResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("private response stream failure"));
        },
      }),
    );

    await expect(
      fetchGitHubApiJson(
        {},
        { fetch: async () => unreadableResponse },
        { headers: {}, path: requestPath, responseSchema },
      ),
    ).rejects.toBeInstanceOf(GitHubApiTransportError);
    await expect(
      fetchGitHubApiJson(
        {},
        {
          fetch: async () => {
            throw new Error("private network failure");
          },
        },
        { headers: {}, path: requestPath, responseSchema },
      ),
    ).rejects.toBeInstanceOf(GitHubApiTransportError);
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
