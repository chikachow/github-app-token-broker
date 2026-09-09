import { githubActionsOidcProviderRegistration } from "@github-app-token-broker/oidc-provider-github-actions";
import { createOidcIdTokenAuthenticator } from "@github-app-token-broker/oidc/id-token-authenticator";
import { parseSubjectTokenAudience } from "@github-app-token-broker/oidc/subject-token-audience";
import {
  createGitHubAppTokenExchange,
  type TokenExchangeComposition,
} from "@github-app-token-broker/token-exchange";
import type { JWTPayload } from "jose";
import { describe, expect, it } from "vitest";

import { buildkiteExampleComposition } from "../examples/buildkite/composition.ts";
import { testNow } from "./support/constants.ts";
import { signRs256Jwt } from "./support/jwt.ts";
import {
  tokenExchangeRequestBody,
  tokenExchangeRequestContext,
} from "./support/token-exchange-request.ts";
import { testPrivateKeyPem, testPublicJwk } from "./support/rsa-test-key-pair.ts";

const buildkiteIdTokenPayload = {
  aud: "https://broker.example",
  exp: 1779581100,
  iat: 1779580790,
  iss: "https://agent.buildkite.com",
  sub: "organization:example:pipeline:release:ref:refs/heads/main:commit:0123456789abcdef:step:publish",
  organization_id: "11111111-1111-4111-8111-111111111111",
  pipeline_id: "22222222-2222-4222-8222-222222222222",
  organization_slug: "example",
  pipeline_slug: "release",
  build_branch: "main",
  build_source: "webhook",
  step_key: "publish",
};

function fixture(composition: TokenExchangeComposition = buildkiteExampleComposition) {
  const githubRequests: Request[] = [];
  const oidcRequests: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === "https://api.github.com") {
      githubRequests.push(request);
      if (request.method === "GET" && url.pathname === "/repos/example-owner/target/installation") {
        return Response.json({ id: 67890, account: { login: "example-owner" } });
      }
      if (request.method === "POST" && url.pathname === "/app/installations/67890/access_tokens") {
        return Response.json(
          {
            token: "ghs_buildkite_fixture",
            expires_at: "2030-01-01T00:00:00Z",
            permissions: { contents: "write" },
          },
          { status: 201 },
        );
      }
    } else {
      oidcRequests.push(url.href);
      if (
        url.href === "https://agent.buildkite.com/.well-known/openid-configuration" ||
        url.href === "https://token.actions.githubusercontent.com/.well-known/openid-configuration"
      ) {
        return Response.json({
          issuer: url.origin,
          id_token_signing_alg_values_supported: ["RS256"],
          jwks_uri: `${url.origin}/.well-known/jwks`,
        });
      }
      if (
        url.href === "https://agent.buildkite.com/.well-known/jwks" ||
        url.href === "https://token.actions.githubusercontent.com/.well-known/jwks"
      ) {
        return Response.json({ keys: [testPublicJwk] });
      }
    }
    throw new Error(`unexpected fixture request: ${request.method} ${url.href}`);
  };
  const dependencies = { fetch, now: () => testNow };
  const authenticator = createOidcIdTokenAuthenticator(
    {
      providerRegistrations: composition.oidcProviderRegistrations,
      subjectTokenAudience: parseSubjectTokenAudience("https://broker.example"),
    },
    dependencies,
  );
  const exchange = createGitHubAppTokenExchange(
    {
      composition,
      githubApp: { appId: "2419473", privateKey: testPrivateKeyPem },
      subjectTokenAudience: "https://broker.example",
    },
    dependencies,
  );

  return {
    authenticator,
    githubRequests,
    oidcRequests,
    async request(token: string, formOverrides: Record<string, string> = {}) {
      return exchange(
        new Request("https://broker.example/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: tokenExchangeRequestBody(
            {
              subjectToken: token,
              resource: "https://api.github.com/repos/example-owner/target",
              scope: "contents:write",
            },
            formOverrides,
          ),
        }),
        tokenExchangeRequestContext(),
      );
    },
  };
}

describe("Buildkite composition example", () => {
  it("issues exactly the example repository and requested permissions", async () => {
    const test = fixture();
    const token = await signRs256Jwt(testPrivateKeyPem, buildkiteIdTokenPayload);
    const authentication = await test.authenticator.authenticateIdToken(token);
    expect(authentication).toMatchObject({ ok: true });
    const response = await test.request(token);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      access_token: "ghs_buildkite_fixture",
      scope: "contents:write",
    });
    expect(test.githubRequests.map((request) => [request.method, request.url])).toEqual([
      ["GET", "https://api.github.com/repos/example-owner/target/installation"],
      ["POST", "https://api.github.com/app/installations/67890/access_tokens"],
    ]);
    expect(await test.githubRequests[1]?.json()).toEqual({
      repositories: ["target"],
      permissions: { contents: "write" },
    });
  });

  for (const claim of ["organization_id", "pipeline_id", "build_branch", "step_key"] as const) {
    it.each([undefined, null, 42, "different"])(
      `authenticates but denies issuance when ${claim} is %s`,
      async (value) => {
        const test = fixture();
        const payload: JWTPayload = { ...buildkiteIdTokenPayload };
        if (value === undefined) delete payload[claim];
        else payload[claim] = value;
        const token = await signRs256Jwt(testPrivateKeyPem, payload);
        expect(await test.authenticator.authenticateIdToken(token)).toMatchObject({ ok: true });
        const response = await test.request(token);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "invalid_request" });
        expect(test.githubRequests).toEqual([]);
      },
    );
  }

  it.each([
    { sub: "customized:job:identity" },
    { organization_slug: "renamed-org", pipeline_slug: "renamed-pipeline" },
    { build_source: "api", build_tag: "v1.0.0" },
  ])("preserves authority when unselected context changes: %j", async (claimOverrides) => {
    const test = fixture();
    const token = await signRs256Jwt(testPrivateKeyPem, {
      ...buildkiteIdTokenPayload,
      ...claimOverrides,
    });
    expect((await test.request(token)).status).toBe(200);
  });

  it("does not let another registered issuer claim Buildkite authority", async () => {
    const test = fixture({
      ...buildkiteExampleComposition,
      oidcProviderRegistrations: [
        ...buildkiteExampleComposition.oidcProviderRegistrations,
        githubActionsOidcProviderRegistration,
      ],
    });
    const token = await signRs256Jwt(testPrivateKeyPem, {
      ...buildkiteIdTokenPayload,
      iss: "https://token.actions.githubusercontent.com",
    });
    expect(await test.authenticator.authenticateIdToken(token)).toMatchObject({ ok: true });
    const response = await test.request(token);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(test.githubRequests).toEqual([]);
    expect(
      test.oidcRequests.every((url) =>
        url.startsWith("https://token.actions.githubusercontent.com/"),
      ),
    ).toBe(true);
  });

  it.each([
    {
      formOverrides: { resource: "https://api.github.com/repos/example-owner/other" },
      error: "invalid_target",
    },
    { formOverrides: { scope: "contents:write actions:write" }, error: "invalid_scope" },
  ])("denies unsupported request authority: %j", async ({ formOverrides, error }) => {
    const test = fixture();
    const token = await signRs256Jwt(testPrivateKeyPem, buildkiteIdTokenPayload);
    const response = await test.request(token, formOverrides);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(test.githubRequests).toEqual([]);
  });
});
