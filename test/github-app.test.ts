import { decodeJwt } from "jose";
import { describe, expect, it, vi } from "vitest";

import {
  createInstallationAccessTokenForRepositoryName,
  resolveInstallationForRepository,
} from "../packages/github/src/app.ts";
import { GitHubApiTransportError } from "../packages/github/src/http.ts";
import { testRepository } from "./support/constants.ts";
import { githubInstallationResponse } from "./support/github-api.ts";
import { testPrivateKeyPem } from "./support/rsa-test-key-pair.ts";

describe("GitHub App authentication", () => {
  it("uses the default GitHub App fetch and clock", async () => {
    const now = new Date("2026-06-29T12:34:00.000Z");
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const githubApp = {
      GITHUB_APP_ID: "2419473",
      GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem,
    };
    const fetchGitHub = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const authorization = new Headers(init?.headers).get("authorization");

      if (authorization === null) {
        throw new Error("expected GitHub App authorization header");
      }

      expect(decodeJwt(authorization.slice("Bearer ".length))).toMatchObject({
        exp: nowSeconds + 9 * 60,
        iat: nowSeconds - 60,
        iss: "2419473",
      });

      return request.method === "POST"
        ? Response.json(
            {
              expires_at: "2030-01-01T00:00:00Z",
              permissions: { contents: "read" },
              token: "ghs_default_dependencies_token",
            },
            { status: 201 },
          )
        : githubInstallationResponse("fixture-owner", 12345);
    });

    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubGlobal("fetch", fetchGitHub);

    try {
      await expect(resolveInstallationForRepository(githubApp, testRepository)).resolves.toEqual({
        id: 12345,
      });
      await expect(
        createInstallationAccessTokenForRepositoryName(githubApp, 12345, "fixture-repository", {
          contents: "read",
        }),
      ).resolves.toEqual({
        expiresAt: "2030-01-01T00:00:00Z",
        permissions: { contents: "read" },
        token: "ghs_default_dependencies_token",
      });
      expect(fetchGitHub).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("reads the app private key from Cloudflare Secrets Store when bound", async () => {
    const secretStoreBinding = {
      get: async () => testPrivateKeyPem,
    };

    const installation = await resolveInstallationForRepository(
      {
        GITHUB_API_BASE_URL: "https://api.github.test",
        GITHUB_APP_ID: "2419473",
        GITHUB_APP_PRIVATE_KEY: secretStoreBinding,
      },
      testRepository,
      {
        fetch: async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
          expect(input).toBeInstanceOf(URL);
          if (!(input instanceof URL)) {
            throw new Error("expected GitHub API request URL");
          }

          expect(input.href).toBe(`https://api.github.test/repos/${testRepository}/installation`);

          const headers = new Headers(init?.headers);
          expect(headers.get("accept")).toBe("application/vnd.github+json");
          expect(headers.get("user-agent")).toBe("github-app-token-broker");
          expect(headers.get("x-github-api-version")).toBe("2022-11-28");
          expect(headers.get("authorization")).toMatch(/^Bearer /u);

          const authorization = headers.get("authorization");

          if (authorization === null) {
            throw new Error("expected GitHub App authorization header");
          }

          expect(decodeJwt(authorization.slice("Bearer ".length))).toMatchObject({
            exp: 1_782_736_980,
            iat: 1_782_736_380,
            iss: "2419473",
          });

          return Response.json({
            account: { login: "fixture-owner" },
            id: 12345,
            node_id: "MDQ6VXNlcjE=",
          });
        },
        now: () => new Date("2026-06-29T12:34:00.000Z"),
      },
    );

    expect(installation).toEqual({ id: 12345 });
  });

  it("matches the installation account owner case-insensitively", async () => {
    await expect(
      resolveTestInstallation(testRepository, githubInstallationResponse("FIXTURE-OWNER", 12345)),
    ).resolves.toEqual({ id: 12345 });
  });

  it("rejects an installation account for a different owner", async () => {
    await expect(
      resolveTestInstallation(
        testRepository,
        githubInstallationResponse("transferred-owner", 12345),
      ),
    ).rejects.toMatchObject({
      message: "invalid installation response",
      status: 502,
    });
  });

  it.each([
    { repository: "", scenario: "an empty repository" },
    { repository: "fixture-owner", scenario: "a repository without a separator" },
    { repository: "/fixture-repository", scenario: "a repository with an empty owner" },
  ])("rejects $scenario before owner comparison", async ({ repository }) => {
    await expect(
      resolveTestInstallation(repository, githubInstallationResponse("fixture-owner", 12345)),
    ).rejects.toMatchObject({
      message: "invalid installation response",
      status: 502,
    });
  });

  it.each([
    { response: "not an object", scenario: "a scalar response" },
    { response: null, scenario: "a null response" },
    { response: [], scenario: "an array response" },
    { response: { id: 12345 }, scenario: "a response without an account" },
    {
      response: { account: { login: "fixture-owner" } },
      scenario: "a response without an installation ID",
    },
    {
      response: { account: null, id: 12345 },
      scenario: "a response with a null account",
    },
    {
      response: { account: [], id: 12345 },
      scenario: "a response with an array account",
    },
    {
      response: { account: {}, id: 12345 },
      scenario: "an account without a login",
    },
    {
      response: { account: { login: 12345 }, id: 12345 },
      scenario: "an account with a non-string login",
    },
    {
      response: { account: { login: "" }, id: 12345 },
      scenario: "an account with an empty login",
    },
    {
      response: { account: { login: "fixture-owner" }, id: "12345" },
      scenario: "a response with a non-numeric installation ID",
    },
    {
      response: { account: { login: "fixture-owner" }, id: 0 },
      scenario: "a response with a non-positive installation ID",
    },
    {
      response: { account: { login: "fixture-owner" }, id: 123.45 },
      scenario: "a response with a fractional installation ID",
    },
  ])("rejects $scenario", async ({ response }) => {
    await expect(
      resolveTestInstallation(testRepository, Response.json(response)),
    ).rejects.toMatchObject({
      message: invalidGitHubApiResponseMessage(`/repos/${testRepository}/installation`),
      status: 502,
    });
  });

  it("rejects malformed successful installation JSON", async () => {
    await expect(resolveTestInstallation(testRepository, new Response("{"))).rejects.toMatchObject({
      message: invalidGitHubApiResponseMessage(`/repos/${testRepository}/installation`),
      status: 502,
    });
  });

  it("rejects an oversized successful installation response as invalid", async () => {
    await expect(
      resolveTestInstallation(
        testRepository,
        Response.json({
          account: { login: "fixture-owner" },
          id: 12345,
          padding: "x".repeat(128 * 1024),
        }),
      ),
    ).rejects.toMatchObject({
      message: invalidGitHubApiResponseMessage(`/repos/${testRepository}/installation`),
      status: 502,
      upstreamStatus: 200,
    });
  });

  it("classifies an unreadable successful installation response as a transport failure", async () => {
    await expect(
      resolveTestInstallation(
        testRepository,
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("response stream failed"));
            },
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(GitHubApiTransportError);
  });

  it("maps a valid access-token response and ignores unknown fields", async () => {
    await expect(
      createTestInstallationAccessToken(
        Response.json({
          expires_at: "2030-01-01T00:00:00Z",
          permissions: { contents: "read" },
          token: "ghs_test_token",
          token_last_eight: "st_token",
        }),
      ),
    ).resolves.toEqual({
      expiresAt: "2030-01-01T00:00:00Z",
      permissions: { contents: "read" },
      token: "ghs_test_token",
    });
  });

  it.each([
    {
      response: {
        expires_at: "2030-01-01T00:00:00Z",
        permissions: { contents: "read" },
      },
      scenario: "a missing token",
    },
    {
      response: {
        expires_at: "not an ISO 8601 datetime",
        permissions: { contents: "read" },
        token: "ghs_test_token",
      },
      scenario: "an ill-formed expiration timestamp",
    },
    {
      response: {
        expires_at: "2030-01-01T00:00:00Z",
        permissions: null,
        token: "ghs_test_token",
      },
      scenario: "null permissions",
    },
    {
      response: {
        expires_at: "2030-01-01T00:00:00Z",
        permissions: [],
        token: "ghs_test_token",
      },
      scenario: "array permissions",
    },
    {
      response: {
        expires_at: "2030-01-01T00:00:00Z",
        permissions: "read",
        token: "ghs_test_token",
      },
      scenario: "scalar permissions",
    },
    {
      response: {
        expires_at: "2030-01-01T00:00:00Z",
        permissions: { contents: 1 },
        token: "ghs_test_token",
      },
      scenario: "a non-string permission value",
    },
    {
      response: {
        expires_at: "2030-01-01T00:00:00Z",
        permissions: { contents: "read" },
        token: "",
      },
      scenario: "an empty token",
    },
  ])("rejects an installation access token response with $scenario", async ({ response }) => {
    await expect(createTestInstallationAccessToken(Response.json(response))).rejects.toMatchObject({
      message: invalidGitHubApiResponseMessage("/app/installations/12345/access_tokens"),
      status: 502,
    });
  });

  it("rejects malformed successful access-token JSON", async () => {
    await expect(createTestInstallationAccessToken(new Response("{"))).rejects.toMatchObject({
      message: invalidGitHubApiResponseMessage("/app/installations/12345/access_tokens"),
      status: 502,
    });
  });
});

function resolveTestInstallation(repository: string, response: Response) {
  return resolveInstallationForRepository(
    {
      GITHUB_APP_ID: "2419473",
      GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem,
    },
    repository,
    {
      fetch: async () => response,
      now: () => new Date("2026-05-24T00:00:00.000Z"),
    },
  );
}

function createTestInstallationAccessToken(response: Response) {
  return createInstallationAccessTokenForRepositoryName(
    {
      GITHUB_APP_ID: "2419473",
      GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem,
    },
    12345,
    "fixture-repository",
    { contents: "read" },
    {
      fetch: async () => response,
      now: () => new Date("2026-05-24T00:00:00.000Z"),
    },
  );
}

function invalidGitHubApiResponseMessage(path: string): string {
  return `GitHub API returned an invalid response: ${path}`;
}
