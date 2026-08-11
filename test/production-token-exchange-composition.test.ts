import { describe, expect, it } from "vitest";

import { createConfiguredTokenExchangeWorker } from "@github-app-token-broker/worker";
import { githubInstallationAccessTokenType, testNow } from "./support/constants.ts";
import {
  fetchOidcRemoteDocumentResponseTestDouble,
  tokenExchangeRequestBody,
} from "./support/oidc.ts";
import { githubInstallationResponse } from "./support/github-api.ts";
import type { TokenExchangeRequestBodyOptions } from "./support/oidc-token.ts";
import { testEnv } from "./support/worker-env.ts";

describe("production token-exchange composition", () => {
  it("exchanges an allowed GitHub Actions token without broadening requested permissions", async () => {
    const fixture = createProductionTokenExchangeFixture();
    const response = await fixture.fetchTokenExchange({
      claims: {
        event_name: "workflow_dispatch",
        ref: "refs/heads/main",
        ref_type: "branch",
        repository: "chikachow/github-app-token-broker",
        sub: "customized-production-subject",
        workflow_ref:
          "chikachow/github-app-token-broker/.github/workflows/pnpm-up.yml@refs/heads/main",
      },
      form: {
        resource: "https://api.github.com/repos/chikachow/github-app-token-broker",
        scope: "pull_requests:read contents:read",
      },
      tokenOptions: {
        audience: productionTokenBrokerAudience,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: "ghs_production_test_token",
      issued_token_type: githubInstallationAccessTokenType,
      scope: "contents:read pull_requests:read",
      token_type: "Bearer",
    });
    expect(fixture.installationAccessTokenRequests).toEqual([
      {
        permissions: { contents: "read", pull_requests: "read" },
        repositories: ["github-app-token-broker"],
      },
    ]);
  });

  it("returns invalid_request for a policy-unacceptable Google subject token", async () => {
    const fixture = createProductionTokenExchangeFixture();
    const response = await fixture.fetchTokenExchange({
      claims: {
        azp: "107517467455664443765",
        sub: "107517467455664443765",
      },
      form: {
        resource: "https://api.github.com/repos/chikachow/github-app-token-broker",
        scope: "contents:read",
      },
      tokenOptions: {
        issuer: "https://accounts.google.com",
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(fixture.githubRequests).toEqual([]);
  });

  it("does not compose Effective Permissions from a non-matching Permit Statement", async () => {
    const fixture = createProductionTokenExchangeFixture();
    const response = await fixture.fetchTokenExchange({
      claims: {
        event_name: "workflow_run",
        ref: "refs/heads/main",
        ref_type: "branch",
        repository: "chikachow/github-app-token-broker",
        sub: "customized-production-subject",
        workflow_ref:
          "chikachow/github-app-token-broker/.github/workflows/run-github-app-token-broker-deploy-update.yml@refs/heads/main",
      },
      form: {
        resource: "https://api.github.com/repos/chikachow/github-app-token-broker-deploy",
        scope: "contents:read",
      },
      tokenOptions: {
        audience: productionTokenBrokerAudience,
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(fixture.githubRequests).toEqual([]);
  });

  it.each([
    ["service name", "github-app-token-broker"],
    ["GitHub App URL", "https://github.com/apps/github-app-token-broker"],
    ["token endpoint URL", productionTokenBrokerUrl],
    ["mismatched hosted origin", "https://broker.example"],
    ["plural audience", [productionTokenBrokerAudience, "https://broker.example"] as string[]],
  ] as const)("rejects the %s subject-token audience", async (_caseName, audience) => {
    const fixture = createProductionTokenExchangeFixture();
    const response = await fixture.fetchTokenExchange({
      claims: {
        event_name: "workflow_dispatch",
        ref: "refs/heads/main",
        ref_type: "branch",
        repository: "chikachow/github-app-token-broker",
        sub: "customized-production-subject",
        workflow_ref:
          "chikachow/github-app-token-broker/.github/workflows/pnpm-up.yml@refs/heads/main",
      },
      form: {
        resource: "https://api.github.com/repos/chikachow/github-app-token-broker",
        scope: "contents:read",
      },
      tokenOptions: { audience },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(fixture.githubRequests).toEqual([]);
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["multiline", "broker\naudience"],
  ] as const)("rejects a malformed %s audience binding", async (_caseName, tokenBrokerAudience) => {
    const fixture = createProductionTokenExchangeFixture({ tokenBrokerAudience });

    await expect(fixture.fetchTokenExchange({})).rejects.toThrow("TOKEN_BROKER_AUDIENCE");
    expect(fixture.githubRequests).toEqual([]);
  });

  it("accepts an exact opaque configured audience", async () => {
    const fixture = createProductionTokenExchangeFixture({
      tokenBrokerAudience: "github-app-token-broker",
    });
    const response = await fixture.fetchTokenExchange({
      claims: {
        event_name: "workflow_dispatch",
        ref: "refs/heads/main",
        ref_type: "branch",
        repository: "chikachow/github-app-token-broker",
        sub: "customized-production-subject",
        workflow_ref:
          "chikachow/github-app-token-broker/.github/workflows/pnpm-up.yml@refs/heads/main",
      },
      form: {
        resource: "https://api.github.com/repos/chikachow/github-app-token-broker",
        scope: "contents:read",
      },
      tokenOptions: { audience: "github-app-token-broker" },
    });

    expect(response.status).toBe(200);
    expect(fixture.installationAccessTokenRequests).toEqual([
      {
        permissions: { contents: "read" },
        repositories: ["github-app-token-broker"],
      },
    ]);
  });

  it("rejects an audience binding change within one Worker isolate", async () => {
    const fixture = createProductionTokenExchangeFixture();
    const firstResponse = await fixture.fetchTokenExchange({
      tokenOptions: { audience: productionTokenBrokerAudience },
    });

    expect(firstResponse.status).toBe(400);
    await expect(
      fixture.fetchTokenExchangeWithAudience("replacement-audience", {}),
    ).rejects.toThrow("TOKEN_BROKER_AUDIENCE must not change during a Worker isolate lifetime");
  });
});

function createProductionTokenExchangeFixture(
  configuration: {
    readonly tokenBrokerAudience?: string;
  } = {},
) {
  const tokenBrokerAudience = configuration.tokenBrokerAudience ?? productionTokenBrokerAudience;
  const githubRequests: string[] = [];
  const installationAccessTokenRequests: unknown[] = [];
  const fetchExternal: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (oidcProviderHostnames.has(url.hostname)) {
      return fetchOidcRemoteDocumentResponseTestDouble(request);
    }

    if (url.hostname === "api.github.com") {
      githubRequests.push(`${request.method} ${url.href}`);
    }

    if (
      request.method === "GET" &&
      url.href === "https://api.github.com/repos/chikachow/github-app-token-broker/installation"
    ) {
      return githubInstallationResponse("chikachow", 13_579);
    }

    if (
      request.method === "POST" &&
      url.href === "https://api.github.com/app/installations/13579/access_tokens"
    ) {
      const body: unknown = await request.json();
      installationAccessTokenRequests.push(body);

      return Response.json(
        {
          expires_at: "2030-01-01T00:00:00Z",
          permissions: { contents: "read", pull_requests: "read" },
          token: "ghs_production_test_token",
        },
        { status: 201 },
      );
    }

    return new Response(`Unexpected external request: ${request.method} ${request.url}`, {
      status: 404,
    });
  };
  const worker = createConfiguredTokenExchangeWorker({
    fetch: fetchExternal,
    now: () => testNow,
  });

  return {
    fetchTokenExchange: async (options: TokenExchangeRequestBodyOptions) => {
      const handler = worker.fetch;

      if (handler === undefined) {
        throw new Error("production token-exchange fixture has no fetch handler");
      }

      return Promise.resolve(
        handler(
          new Request("https://example.test/token", {
            body: await tokenExchangeRequestBody(options),
            headers: { "content-type": "application/x-www-form-urlencoded" },
            method: "POST",
          }) as Parameters<typeof handler>[0],
          tokenExchangeEnv(tokenBrokerAudience),
          {} as ExecutionContext,
        ),
      );
    },
    fetchTokenExchangeWithAudience: async (
      audience: string,
      options: TokenExchangeRequestBodyOptions,
    ) => {
      const handler = worker.fetch;

      if (handler === undefined) {
        throw new Error("production token-exchange fixture has no fetch handler");
      }

      return Promise.resolve(
        handler(
          new Request("https://example.test/token", {
            body: await tokenExchangeRequestBody(options),
            headers: { "content-type": "application/x-www-form-urlencoded" },
            method: "POST",
          }) as Parameters<typeof handler>[0],
          tokenExchangeEnv(audience),
          {} as ExecutionContext,
        ),
      );
    },
    githubRequests,
    installationAccessTokenRequests,
  };
}

const oidcProviderHostnames = new Set([
  "accounts.google.com",
  "token.actions.githubusercontent.com",
  "www.googleapis.com",
]);

const productionTokenBrokerUrl = "https://cyspbot.chikachow.org/token";
const productionTokenBrokerAudience = "https://cyspbot.chikachow.org";

function tokenExchangeEnv(tokenBrokerAudience: string): TokenExchangeEnv {
  return {
    ...testEnv,
    TOKEN_BROKER_AUDIENCE: tokenBrokerAudience,
  } as unknown as TokenExchangeEnv;
}
