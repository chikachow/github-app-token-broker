import { decodeJwt } from "jose";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  createGitHubAppInformation,
  type GitHubApp,
  GitHubAppInputError,
  GitHubAppInternalError,
  type GitHubAppInstallation,
  GitHubAppNotFoundError,
  GitHubAppUnavailableError,
  GitHubAppUpstreamError,
} from "../packages/github/src/app-information.ts";
import { GitHubAppConfigurationError } from "../packages/github/src/app.ts";
import { GitHubAppInformationEntrypoint } from "../workers/github-app-token-broker/src/app-information-entrypoint.ts";
import {
  testGitHubAppResponse,
  testGitHubEnterpriseAccount,
  testGitHubInstallationResponse,
  testGitHubUserAccount,
} from "./support/github-app-information.ts";
import { testPrivateKeyPem } from "./support/rsa-test-key-pair.ts";

const githubApp = {
  GITHUB_API_BASE_URL: "https://api.github.test",
  GITHUB_APP_ID: "2419473",
  GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem,
};

const now = new Date("2026-06-29T12:34:00.000Z");

describe("GitHub App information", () => {
  it("models GitHub's documented required response fields", () => {
    expectTypeOf<GitHubApp["created_at"]>().toEqualTypeOf<string>();
    expectTypeOf<GitHubApp["description"]>().toEqualTypeOf<string | null>();
    expectTypeOf<GitHubApp["external_url"]>().toEqualTypeOf<string>();
    expectTypeOf<GitHubApp["html_url"]>().toEqualTypeOf<string>();
    expectTypeOf<GitHubApp["node_id"]>().toEqualTypeOf<string>();
    expectTypeOf<GitHubApp["updated_at"]>().toEqualTypeOf<string>();
    expectTypeOf<GitHubAppInstallation["access_tokens_url"]>().toEqualTypeOf<string>();
    expectTypeOf<GitHubAppInstallation["app_id"]>().toEqualTypeOf<number>();
    expectTypeOf<GitHubAppInstallation["app_slug"]>().toEqualTypeOf<string>();
    expectTypeOf<GitHubAppInstallation["created_at"]>().toEqualTypeOf<string>();
    expectTypeOf<GitHubAppInstallation["events"]>().toEqualTypeOf<string[]>();
    expectTypeOf<GitHubAppInstallation["html_url"]>().toEqualTypeOf<string>();
    expectTypeOf<GitHubAppInstallation["permissions"]>().toEqualTypeOf<Record<string, string>>();
    expectTypeOf<GitHubAppInstallation["repositories_url"]>().toEqualTypeOf<string>();
    expectTypeOf<GitHubAppInstallation["repository_selection"]>().toEqualTypeOf<string>();
    expectTypeOf<GitHubAppInstallation["single_file_name"]>().toEqualTypeOf<string | null>();
    expectTypeOf<GitHubAppInstallation["suspended_at"]>().toEqualTypeOf<string | null>();
    expectTypeOf<GitHubAppInstallation["target_id"]>().toEqualTypeOf<number>();
    expectTypeOf<GitHubAppInstallation["target_type"]>().toEqualTypeOf<string>();
    expectTypeOf<GitHubAppInstallation["updated_at"]>().toEqualTypeOf<string>();
  });

  it("delegates all methods through the named WorkerEntrypoint", async () => {
    const fetchGitHub = vi.fn<typeof fetch>(async (input) => {
      switch (requestUrl(input).pathname) {
        case "/app":
          return Response.json(testGitHubAppResponse);
        case "/app/installations":
          return Response.json([]);
        default:
          return Response.json(testGitHubInstallationResponse);
      }
    });
    vi.stubGlobal("fetch", fetchGitHub);

    try {
      const entrypoint = new GitHubAppInformationEntrypoint({} as ExecutionContext, githubApp);

      await expect(entrypoint.getApp()).resolves.toMatchObject({ id: 2419473 });
      await expect(entrypoint.listInstallations()).resolves.toEqual([]);
      await expect(entrypoint.getInstallation({ installation_id: 12345 })).resolves.toMatchObject({
        id: 12345,
      });
      await expect(
        entrypoint.getRepositoryInstallation({
          owner: "fixture-owner",
          repo: "fixture-repository",
        }),
      ).resolves.toMatchObject({ id: 12345 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the App JWT and preserves GitHub response shapes", async () => {
    const responses = new Map<string, unknown>([
      [
        "/app",
        {
          ...testGitHubAppResponse,
          owner: { ...testGitHubUserAccount, custom_owner_field: true },
          installations_count: 2,
          custom_app_field: "preserved",
        },
      ],
      [
        "/app/installations",
        [
          {
            ...testGitHubInstallationResponse,
            account: { ...testGitHubUserAccount, custom_account_field: "preserved" },
            permissions: { contents: "read" },
            repository_selection: "selected",
            custom_installation_field: { enabled: true },
          },
        ],
      ],
      [
        "/app/installations/12345",
        {
          ...testGitHubInstallationResponse,
          permissions: { contents: "read" },
        },
      ],
      [
        "/repos/fixture-owner/fixture-repository/installation",
        {
          ...testGitHubInstallationResponse,
          permissions: { contents: "read" },
        },
      ],
    ]);
    const fetchGitHub = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const authorization = request.headers.get("authorization");

      expect(request.method).toBe("GET");
      expect(request.headers.get("accept")).toBe("application/vnd.github+json");
      expect(request.headers.get("user-agent")).toBe("github-app-token-broker");
      expect(request.headers.get("x-github-api-version")).toBe("2022-11-28");
      expect(authorization).toMatch(/^Bearer /u);

      if (authorization === null) {
        throw new Error("expected GitHub App authorization");
      }

      expect(decodeJwt(authorization.slice("Bearer ".length)).iss).toBe("2419473");

      const body = responses.get(url.pathname);

      if (body === undefined) {
        return new Response(null, { status: 404 });
      }

      return Response.json(body);
    });
    const information = createGitHubAppInformation(githubApp, {
      fetch: fetchGitHub,
      now: () => now,
    });

    await expect(information.getApp()).resolves.toMatchObject({
      custom_app_field: "preserved",
      installations_count: 2,
    });
    await expect(
      information.listInstallations({
        outdated: "true",
        page: 2,
        per_page: 100,
        since: "2026-01-01T00:00:00Z",
      }),
    ).resolves.toMatchObject([
      {
        account: { custom_account_field: "preserved" },
        custom_installation_field: { enabled: true },
      },
    ]);
    await expect(information.getInstallation({ installation_id: 12345 })).resolves.toMatchObject({
      id: 12345,
    });
    await expect(
      information.getRepositoryInstallation({ owner: "fixture-owner", repo: "fixture-repository" }),
    ).resolves.toMatchObject({ id: 12345 });

    const listRequest = fetchGitHub.mock.calls[1]?.[0];

    if (listRequest === undefined) {
      throw new Error("missing list installations request");
    }

    const listUrl = requestUrl(listRequest);

    expect(listUrl.pathname).toBe("/app/installations");
    expect([...listUrl.searchParams]).toEqual([
      ["page", "2"],
      ["per_page", "100"],
      ["since", "2026-01-01T00:00:00Z"],
      ["outdated", "true"],
    ]);
    expect(fetchGitHub.mock.calls.map(([input]) => requestUrl(input).pathname)).toEqual([
      "/app",
      "/app/installations",
      "/app/installations/12345",
      "/repos/fixture-owner/fixture-repository/installation",
    ]);
  });

  it("accepts an installation whose account is an enterprise", async () => {
    const enterpriseInstallation = {
      ...testGitHubInstallationResponse,
      account: testGitHubEnterpriseAccount,
      html_url: "https://github.com/enterprises/fixture-enterprise/settings/installations/12345",
      target_type: "Enterprise",
    };
    const information = createGitHubAppInformation(githubApp, {
      fetch: async () => Response.json([enterpriseInstallation]),
      now: () => now,
    });

    await expect(information.listInstallations()).resolves.toEqual([enterpriseInstallation]);
  });

  it("passes through empty since and outdated values", async () => {
    const fetchGitHub = vi.fn<typeof fetch>(async () => Response.json([]));
    const information = createGitHubAppInformation(githubApp, {
      fetch: fetchGitHub,
      now: () => now,
    });

    await expect(information.listInstallations({ since: "", outdated: "" })).resolves.toEqual([]);

    const request = fetchGitHub.mock.calls[0]?.[0];

    if (request === undefined) {
      throw new Error("missing list installations request");
    }

    expect([...requestUrl(request).searchParams]).toEqual([
      ["since", ""],
      ["outdated", ""],
    ]);
  });

  it("accepts an installation whose account is null", async () => {
    const installation = { ...testGitHubInstallationResponse, account: null };
    const information = createGitHubAppInformation(githubApp, {
      fetch: async () => Response.json(installation),
      now: () => now,
    });

    await expect(information.getInstallation({ installation_id: 12345 })).resolves.toEqual(
      installation,
    );
  });

  it("returns an unknown non-empty installation repository selection unchanged", async () => {
    const installation = {
      ...testGitHubInstallationResponse,
      repository_selection: "future-selection",
    };
    const information = createGitHubAppInformation(githubApp, {
      fetch: async () => Response.json(installation),
      now: () => now,
    });

    await expect(information.getInstallation({ installation_id: 12345 })).resolves.toEqual(
      installation,
    );
  });

  it("accepts an enterprise-owned app without the optional slug", async () => {
    const app = {
      created_at: testGitHubAppResponse.created_at,
      description: testGitHubAppResponse.description,
      events: testGitHubAppResponse.events,
      external_url: testGitHubAppResponse.external_url,
      html_url: testGitHubAppResponse.html_url,
      id: testGitHubAppResponse.id,
      name: testGitHubAppResponse.name,
      node_id: testGitHubAppResponse.node_id,
      owner: testGitHubEnterpriseAccount,
      permissions: testGitHubAppResponse.permissions,
      updated_at: testGitHubAppResponse.updated_at,
    };
    const information = createGitHubAppInformation(githubApp, {
      fetch: async () => Response.json(app),
      now: () => now,
    });

    await expect(information.getApp()).resolves.toEqual(app);
  });

  it("returns a full GitHub page of 100 installations", async () => {
    const installations = Array.from({ length: 100 }, (_, index) => ({
      ...testGitHubInstallationResponse,
      access_tokens_url: `https://api.github.com/app/installations/${index + 1}/access_tokens`,
      events: ["push", "pull_request"],
      html_url: `https://github.com/settings/installations/${index + 1}`,
      id: index + 1,
      permissions: { contents: "read", metadata: "read", pull_requests: "write" },
    }));
    const responseBody = JSON.stringify(installations);

    if (new TextEncoder().encode(responseBody).byteLength <= 64 * 1024) {
      throw new Error("installation page fixture must exceed the default GitHub response limit");
    }

    const information = createGitHubAppInformation(githubApp, {
      fetch: async () =>
        new Response(responseBody, { headers: { "content-type": "application/json" } }),
      now: () => now,
    });

    await expect(information.listInstallations({ per_page: 100 })).resolves.toHaveLength(100);
  });

  it("accepts an installation page at the 1 MiB response limit", async () => {
    const responseBody = installationPageResponseBody(1024 * 1024);
    const information = createGitHubAppInformation(githubApp, {
      fetch: async () => new Response(responseBody),
      now: () => now,
    });

    await expect(information.listInstallations()).resolves.toHaveLength(1);
  });

  it("rejects an installation page over the 1 MiB response limit", async () => {
    const responseBody = installationPageResponseBody(1024 * 1024 + 1);
    const information = createGitHubAppInformation(githubApp, {
      fetch: async () => new Response(responseBody),
      now: () => now,
    });

    await expect(information.listInstallations()).rejects.toBeInstanceOf(GitHubAppUpstreamError);
  });

  it("rejects invalid RPC inputs before making a GitHub request", async () => {
    const fetchGitHub = vi.fn<typeof fetch>();
    const information = createGitHubAppInformation(githubApp, {
      fetch: fetchGitHub,
      now: () => now,
    });

    await expect(information.listInstallations({ per_page: 101 })).rejects.toBeInstanceOf(
      GitHubAppInputError,
    );
    await expect(information.getInstallation({ installation_id: 0 })).rejects.toBeInstanceOf(
      GitHubAppInputError,
    );
    await expect(
      information.getRepositoryInstallation({ owner: "fixture/owner", repo: "fixture-repository" }),
    ).rejects.toBeInstanceOf(GitHubAppInputError);
    await expect(
      information.getRepositoryInstallation({ owner: "\u0000", repo: "fixture-repository" }),
    ).rejects.toBeInstanceOf(GitHubAppInputError);
    await expect(
      information.getRepositoryInstallation({ owner: "\ud800", repo: "fixture-repository" }),
    ).rejects.toBeInstanceOf(GitHubAppInputError);
    await expect(
      information.getRepositoryInstallation({
        owner: "fixture-owner",
        repo: "fixture-repository.git",
      }),
    ).rejects.toBeInstanceOf(GitHubAppInputError);
    await expect(
      information.getRepositoryInstallation({
        owner: "fixture-owner",
        repo: "fixture-repository.GIT",
      }),
    ).rejects.toBeInstanceOf(GitHubAppInputError);
    expect(fetchGitHub).not.toHaveBeenCalled();
  });

  it("preserves private-key configuration errors", async () => {
    await expect(
      createGitHubAppInformation({
        ...githubApp,
        GITHUB_APP_PRIVATE_KEY: "not a private key",
      }).getApp(),
    ).rejects.toBeInstanceOf(GitHubAppConfigurationError);
  });

  it.each([
    {
      configuration: { ...githubApp, GITHUB_APP_ID: "not-an-app-id" },
      description: "malformed App ID",
    },
    {
      configuration: { ...githubApp, GITHUB_APP_ID: "0" },
      description: "zero App ID",
    },
    {
      configuration: { ...githubApp, GITHUB_APP_ID: "02419473" },
      description: "App ID with a leading zero",
    },
    {
      configuration: { ...githubApp, GITHUB_API_BASE_URL: "not a URL" },
      description: "invalid GitHub API base URL",
    },
    {
      configuration: { ...githubApp, GITHUB_API_BASE_URL: "http://api.github.test" },
      description: "plaintext GitHub API base URL",
    },
  ])("classifies $description as invalid configuration", async ({ configuration }) => {
    const fetchGitHub = vi.fn<typeof fetch>();

    await expect(
      createGitHubAppInformation(configuration, {
        fetch: fetchGitHub,
        now: () => now,
      }).getApp(),
    ).rejects.toBeInstanceOf(GitHubAppConfigurationError);
    expect(fetchGitHub).not.toHaveBeenCalled();
  });

  it("sanitizes unexpected local failures as internal errors", async () => {
    await expect(
      createGitHubAppInformation(githubApp, {
        fetch: vi.fn<typeof fetch>(),
        now: () => {
          throw new Error("clock failure");
        },
      }).getApp(),
    ).rejects.toBeInstanceOf(GitHubAppInternalError);
  });

  it.each([
    {
      error: GitHubAppConfigurationError,
      response: new Response(null, { status: 401 }),
      method: "getApp" as const,
    },
    {
      error: GitHubAppNotFoundError,
      response: new Response(null, { status: 404 }),
      method: "getInstallation" as const,
    },
    {
      error: GitHubAppUnavailableError,
      response: new Response(null, {
        headers: { "x-ratelimit-remaining": "0" },
        status: 403,
      }),
      method: "getApp" as const,
    },
    {
      error: GitHubAppUnavailableError,
      response: new Response(null, { status: 503 }),
      method: "getApp" as const,
    },
    {
      error: GitHubAppUpstreamError,
      response: new Response(null, { status: 500 }),
      method: "getApp" as const,
    },
  ])("normalizes GitHub failures to stable RPC errors", async ({ error, method, response }) => {
    const information = createGitHubAppInformation(githubApp, {
      fetch: async () => response,
      now: () => now,
    });

    const result =
      method === "getInstallation"
        ? information.getInstallation({ installation_id: 12345 })
        : information.getApp();

    await expect(result).rejects.toBeInstanceOf(error);
  });

  it("maps transport failures to an unavailable RPC error", async () => {
    const information = createGitHubAppInformation(githubApp, {
      fetch: async () => {
        throw new Error("network details must not cross the RPC boundary");
      },
      now: () => now,
    });

    await expect(information.getApp()).rejects.toBeInstanceOf(GitHubAppUnavailableError);
  });
});

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof Request) {
    return new URL(input.url);
  }

  return new URL(input instanceof URL ? input.href : input);
}

function installationPageResponseBody(byteLength: number): string {
  const emptyResponseBody = JSON.stringify([
    { ...testGitHubInstallationResponse, fixture_padding: "" },
  ]);
  const paddingLength = byteLength - new TextEncoder().encode(emptyResponseBody).byteLength;

  if (paddingLength < 0) {
    throw new Error("installation page fixture byte length is too small");
  }

  const responseBody = JSON.stringify([
    { ...testGitHubInstallationResponse, fixture_padding: "x".repeat(paddingLength) },
  ]);

  if (new TextEncoder().encode(responseBody).byteLength !== byteLength) {
    throw new Error("installation page fixture has the wrong byte length");
  }

  return responseBody;
}
