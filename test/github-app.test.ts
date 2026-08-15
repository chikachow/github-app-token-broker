import { decodeJwt } from "jose";
import { describe, expect, it, vi } from "vitest";

import {
  createInstallationAccessTokenForRepositoryName,
  resolveInstallationForRepository,
} from "../packages/github/src/app.ts";
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

      if (request.method === "POST") {
        expect(request.headers.has("x-github-stateless-s2s-token")).toBe(false);

        return Response.json(
          {
            expires_at: "2030-01-01T00:00:00Z",
            permissions: { contents: "read" },
            token: "ghs_default_dependencies_token",
          },
          { status: 201 },
        );
      }

      return githubInstallationResponse("fixture-owner", 12345);
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

          expect(input.href).toBe(`https://api.github.com/repos/${testRepository}/installation`);

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
      message: invalidGitHubApiResponseMessage(`/repos/${testRepository}/installation`),
      status: 502,
      upstreamStatus: 200,
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
      message: invalidGitHubApiResponseMessage(`/repos/${repository}/installation`),
      status: 502,
      upstreamStatus: 200,
    });
  });

  it("rejects a schema-invalid successful installation response", async () => {
    await expect(
      resolveTestInstallation(
        testRepository,
        Response.json({ account: { login: "fixture-owner" }, id: "12345" }),
      ),
    ).rejects.toMatchObject({
      message: invalidGitHubApiResponseMessage(`/repos/${testRepository}/installation`),
      status: 502,
    });
  });

  it.each([
    { scenario: "opaque", token: "ghs_test_token" },
    {
      scenario: "JWT-shaped",
      token: "ghs_eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIyNDE5NDczIn0.fixture-signature",
    },
  ])("maps a valid $scenario access token and ignores unknown fields", async ({ token }) => {
    await expect(
      createTestInstallationAccessToken(
        Response.json({
          expires_at: "2030-01-01T00:00:00Z",
          permissions: { contents: "read" },
          token,
          token_last_eight: "st_token",
        }),
      ),
    ).resolves.toEqual({
      expiresAt: "2030-01-01T00:00:00Z",
      permissions: { contents: "read" },
      token,
    });
  });

  it("rejects a schema-invalid successful access-token response", async () => {
    await expect(
      createTestInstallationAccessToken(
        Response.json({
          expires_at: "2030-01-01T00:00:00Z",
          permissions: { contents: "read" },
        }),
      ),
    ).rejects.toMatchObject({
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
