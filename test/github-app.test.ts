import { decodeJwt } from "jose";
import { describe, expect, it, vi } from "vitest";

import {
  issueInstallationAccessToken,
  type GitHubAppConfiguration,
} from "../packages/github/src/app.ts";
import { createInstallationAccessTokenRequest } from "@github-app-token-broker/github/installation-access-token-request";
import { testInstallationId, testRepository } from "./support/constants.ts";
import { githubInstallationResponse } from "./support/github-api.ts";
import { testPrivateKeyPem } from "./support/rsa-test-key-pair.ts";

describe("GitHub App authentication", () => {
  it("uses one App authentication resolution for repository-scoped issuance", async () => {
    const now = new Date("2026-06-29T12:34:00.000Z");
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const githubApp = {
      appId: "2419473",
      privateKey: testPrivateKeyPem,
    } satisfies GitHubAppConfiguration;
    const authorizationHeaders: string[] = [];
    const fetchGitHub = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const authorization = new Headers(init?.headers).get("authorization");

      if (authorization === null) {
        throw new Error("expected GitHub App authorization header");
      }

      authorizationHeaders.push(authorization);

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
      await expect(
        issueInstallationAccessToken(
          githubApp,
          createInstallationAccessTokenRequest({
            owner: "fixture-owner",
            permissions: { contents: "read" },
            repository: "fixture-repository",
          }),
        ),
      ).resolves.toEqual({
        expiresAt: "2030-01-01T00:00:00Z",
        installationId: 12345,
        ok: true,
        permissions: { contents: "read" },
        revoke: expect.any(Function),
        token: "ghs_default_dependencies_token",
      });
      expect(fetchGitHub).toHaveBeenCalledTimes(2);
      expect(authorizationHeaders).toHaveLength(2);
      expect(authorizationHeaders[0]).toBe(authorizationHeaders[1]);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("reads the app private key from Cloudflare Secrets Store when bound", async () => {
    const secretStoreBinding = {
      get: vi.fn(async () => testPrivateKeyPem),
    };

    const issuance = await issueInstallationAccessToken(
      {
        appId: "2419473",
        privateKey: secretStoreBinding,
      },
      createInstallationAccessTokenRequest({
        owner: "fixture-owner",
        permissions: { contents: "read" },
        repository: "fixture-source-repository",
      }),
      {
        fetch: async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
          expect(input).toBeInstanceOf(URL);
          if (!(input instanceof URL)) {
            throw new Error("expected GitHub API request URL");
          }

          const request = new Request(input, init);
          expect(input.href).toBe(
            request.method === "GET"
              ? `https://api.github.com/repos/${testRepository}/installation`
              : "https://api.github.com/app/installations/12345/access_tokens",
          );

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

          return request.method === "GET"
            ? Response.json({
                account: { login: "fixture-owner" },
                id: 12345,
                node_id: "MDQ6VXNlcjE=",
              })
            : Response.json(
                {
                  expires_at: "2030-01-01T00:00:00Z",
                  permissions: { contents: "read" },
                  token: "ghs_secret_store_token",
                },
                { status: 201 },
              );
        },
        now: () => new Date("2026-06-29T12:34:00.000Z"),
      },
    );

    expect(issuance).toEqual({
      expiresAt: "2030-01-01T00:00:00Z",
      installationId: 12345,
      ok: true,
      permissions: { contents: "read" },
      revoke: expect.any(Function),
      token: "ghs_secret_store_token",
    });
    expect(secretStoreBinding.get).toHaveBeenCalledOnce();
  });

  it("matches the installation account owner case-insensitively", async () => {
    await expect(
      issueTestInstallationAccessToken(
        githubInstallationResponse("FIXTURE-OWNER", testInstallationId),
      ),
    ).resolves.toMatchObject({
      installationId: testInstallationId,
      ok: true,
    });
  });

  it("returns an upstream failure for an installation account with a different owner", async () => {
    await expect(
      issueTestInstallationAccessToken(
        githubInstallationResponse("transferred-owner", testInstallationId),
      ),
    ).resolves.toEqual({
      error: {
        message: invalidGitHubApiResponseMessage(`/repos/${testRepository}/installation`),
        name: "GitHubApiError",
        status: 502,
        upstreamStatus: 200,
      },
      installationId: undefined,
      ok: false,
      reason: "upstream_failure",
    });
  });

  it("returns an upstream failure for a schema-invalid successful installation response", async () => {
    await expect(
      issueTestInstallationAccessToken(
        Response.json({ account: { login: "fixture-owner" }, id: "12345" }),
      ),
    ).resolves.toEqual({
      error: {
        message: invalidGitHubApiResponseMessage(`/repos/${testRepository}/installation`),
        name: "GitHubApiError",
        status: 502,
        upstreamStatus: 200,
      },
      installationId: undefined,
      ok: false,
      reason: "upstream_failure",
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
      issueTestInstallationAccessToken(
        githubInstallationResponse("fixture-owner", testInstallationId),
        Response.json({
          expires_at: "2030-01-01T00:00:00Z",
          permissions: { contents: "read" },
          token,
          token_last_eight: "st_token",
        }),
      ),
    ).resolves.toEqual({
      expiresAt: "2030-01-01T00:00:00Z",
      installationId: testInstallationId,
      ok: true,
      permissions: { contents: "read" },
      revoke: expect.any(Function),
      token,
    });
  });

  it("returns an upstream failure for a schema-invalid successful access-token response", async () => {
    await expect(
      issueTestInstallationAccessToken(
        githubInstallationResponse("fixture-owner", testInstallationId),
        Response.json({
          expires_at: "2030-01-01T00:00:00Z",
          permissions: { contents: "read" },
        }),
      ),
    ).resolves.toEqual({
      error: {
        message: invalidGitHubApiResponseMessage(
          `/app/installations/${testInstallationId}/access_tokens`,
        ),
        name: "GitHubApiError",
        status: 502,
        upstreamStatus: 200,
      },
      installationId: testInstallationId,
      ok: false,
      reason: "upstream_failure",
    });
  });
});

function issueTestInstallationAccessToken(
  installationResponse: Response,
  tokenResponse: Response = Response.json(
    {
      expires_at: "2030-01-01T00:00:00Z",
      permissions: { contents: "read" },
      token: "ghs_test_token",
    },
    { status: 201 },
  ),
) {
  return issueInstallationAccessToken(
    {
      appId: "2419473",
      privateKey: testPrivateKeyPem,
    },
    createInstallationAccessTokenRequest({
      owner: "fixture-owner",
      permissions: { contents: "read" },
      repository: "fixture-source-repository",
    }),
    {
      fetch: async (input, init) =>
        new Request(input, init).method === "GET" ? installationResponse : tokenResponse,
      now: () => new Date("2026-05-24T00:00:00.000Z"),
    },
  );
}

function invalidGitHubApiResponseMessage(path: string): string {
  return `GitHub API returned an invalid response: ${path}`;
}
