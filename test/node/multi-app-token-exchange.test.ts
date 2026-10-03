import {
  createGitHubAppTokenExchange,
  type GitHubAppTokenExchangeConfiguration,
  type TokenExchangeObservation,
} from "@github-app-token-broker/token-exchange";
import { compileTokenIssuancePolicy } from "@github-app-token-broker/token-issuance-policy";
import { decodeJwt, exportPKCS8, generateKeyPair, importJWK, jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";

import {
  fetchGitHubActionsTokenExchangeExternalTestDouble,
  githubActionsTokenExchangeRequest,
  testGitHubActionsTokenExchangeConfiguration,
} from "../support/github-actions-token-exchange.ts";
import { testNow } from "../support/constants.ts";
import { testPrivateKeyPem, testPublicJwk } from "../support/rsa-test-key-pair.ts";

describe("app selection at the Token Exchange boundary", () => {
  it("does not use another app's Permit Statements or secret", async () => {
    const readOtherSecret = vi.fn(async () => testPrivateKeyPem);
    const fetch = vi.fn(fetchGitHubActionsTokenExchangeExternalTestDouble);
    const exchange = createGitHubAppTokenExchange(
      {
        composition: testGitHubActionsTokenExchangeConfiguration.composition,
        githubApps: [
          {
            slug: "fixture-app",
            clientId: "Iv1.fixtureApp",
            privateKey: testPrivateKeyPem,
            subjectTokenAudiences: ["https://broker.example"],
          },
          {
            slug: "other-app",
            clientId: "Iv1.otherApp",
            privateKey: { get: readOtherSecret },
            subjectTokenAudiences: ["https://broker.example"],
          },
        ],
      },
      { fetch, now: () => testNow },
    );
    const request = await githubActionsTokenExchangeRequest();
    const response = await exchange(
      new Request("https://broker.example/github/apps/other-app/token", request),
      { observe: async () => undefined },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_target" });
    expect(readOtherSecret).not.toHaveBeenCalled();
    expect(
      fetch.mock.calls.every(
        ([input]) =>
          new URL(input instanceof Request ? input.url : String(input)).hostname !==
          "api.github.com",
      ),
    ).toBe(true);
  });

  it("uses distinct app keys and shared issuer caches for concurrent exchanges", async () => {
    const fixture = await multiAppFixture();
    const responses = await Promise.all([
      fixture.exchange(await appRequest("fixture-app"), fixture.context),
      fixture.exchange(await appRequest("other-app"), fixture.context),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
      expect.objectContaining({ access_token: "token-Iv1.fixtureApp" }),
      expect.objectContaining({ access_token: "token-Iv1.otherApp" }),
    ]);
    expect(fixture.providerRequests).toHaveLength(2);
    expect(fixture.readPrimarySecret).toHaveBeenCalledOnce();
    expect(fixture.readOtherSecret).toHaveBeenCalledOnce();
    expect(fixture.mints).toEqual(
      expect.arrayContaining([
        {
          clientId: "Iv1.fixtureApp",
          body: {
            repositories: ["fixture-source-repository"],
            permissions: { contents: "read", pull_requests: "read" },
          },
        },
        {
          clientId: "Iv1.otherApp",
          body: {
            repositories: ["fixture-source-repository"],
            permissions: { contents: "read", pull_requests: "read" },
          },
        },
      ]),
    );
    expect(
      fixture.observations
        .filter(({ fields }) => fields["event"] === "installation_access_token_issuance_succeeded")
        .map(({ fields }) => fields["github_app"]),
    ).toEqual(
      expect.arrayContaining([{ client_id: "Iv1.fixtureApp" }, { client_id: "Iv1.otherApp" }]),
    );
  });

  it("does not borrow the other app's write permission for the same subject and repository", async () => {
    const fixture = await multiAppFixture();
    const response = await fixture.exchange(
      await appRequest("other-app", {}, "contents:write pull_requests:write"),
      fixture.context,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_scope" });
    expect(fixture.mints).toEqual([]);
    expect(fixture.readOtherSecret).not.toHaveBeenCalled();
    expect(fixture.readPrimarySecret).not.toHaveBeenCalled();
  });

  it("accepts an app's vanity audience but rejects it for another app with a warm shared cache", async () => {
    const fixture = await multiAppFixture();
    const accepted = await fixture.exchange(
      await appRequest("fixture-app", { aud: "https://primary.example" }),
      fixture.context,
    );
    expect(accepted.status).toBe(200);
    const rejected = await fixture.exchange(
      await appRequest("other-app", { aud: "https://primary.example" }),
      fixture.context,
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: "invalid_request" });
    expect(fixture.providerRequests).toHaveLength(2);
    expect(fixture.readOtherSecret).not.toHaveBeenCalled();
    expect(fixture.mints).toHaveLength(1);
    const otherVanity = await fixture.exchange(
      await appRequest("other-app", { aud: "https://other.example", azp: "https://other.example" }),
      fixture.context,
    );
    expect(otherVanity.status).toBe(200);
  });

  it.each([
    undefined,
    "",
    ["https://broker.example"],
    ["https://broker.example", "https://other.example"],
    "https://other.example/",
    " https://broker.example",
  ])("rejects unsupported audience %j before accessing an app key", async (aud) => {
    const fixture = await multiAppFixture();
    const response = await fixture.exchange(
      await appRequest("other-app", { aud }),
      fixture.context,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(fixture.readOtherSecret).not.toHaveBeenCalled();
    expect(fixture.mints).toEqual([]);
  });

  it("does not use the request host or forwarded headers as an audience", async () => {
    const fixture = await multiAppFixture();
    const request = new Request(
      "https://other.example/github/apps/other-app/token",
      await appRequest("other-app", { aud: "https://primary.example" }),
    );
    request.headers.set("x-forwarded-host", "primary.example");
    const response = await fixture.exchange(request, fixture.context);
    expect(response.status).toBe(400);
    expect(fixture.readOtherSecret).not.toHaveBeenCalled();
  });

  it("isolates an unavailable app secret from an otherwise permitted app", async () => {
    const fixture = await multiAppFixture();
    fixture.readOtherSecret.mockRejectedValue(new Error("private secret failure"));
    const response = await fixture.exchange(await appRequest("other-app"), fixture.context);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "server_error" });
    expect(JSON.stringify(fixture.observations)).not.toContain("private secret failure");
    expect((await fixture.exchange(await appRequest("fixture-app"), fixture.context)).status).toBe(
      200,
    );
    expect(fixture.mints).toHaveLength(1);
  });

  it.each([
    "/token",
    "/github/apps/missing/token",
    "/github/apps/OTHER-APP/token",
    "/github/apps/other-app/token/",
  ])("rejects unconfigured route %s before authentication or secret access", async (path) => {
    const fixture = await multiAppFixture();
    const response = await fixture.exchange(
      new Request(`https://broker.example${path}`, await appRequest("other-app")),
      fixture.context,
    );
    expect(response.status).toBe(404);
    expect(fixture.providerRequests).toEqual([]);
    expect(fixture.readOtherSecret).not.toHaveBeenCalled();
    expect(fixture.readPrimarySecret).not.toHaveBeenCalled();
  });

  it.each([
    { name: "duplicate slug", override: { slug: "fixture-app" } },
    { name: "duplicate client ID", override: { clientId: "Iv1.fixtureApp" } },
    { name: "numeric App ID", override: { clientId: "12345" } },
    { name: "noncanonical slug", override: { slug: "Other-App" } },
    { name: "empty audiences", override: { subjectTokenAudiences: [] } },
    {
      name: "duplicate audiences",
      override: { subjectTokenAudiences: ["https://broker.example", "https://broker.example"] },
    },
  ])("rejects $name at construction", async ({ override }) => {
    const fixture = await multiAppFixture();
    const [first, second] = fixture.configuration.githubApps;
    expect(() =>
      createGitHubAppTokenExchange(
        {
          ...fixture.configuration,
          githubApps: [first, { ...second, ...override }],
        },
        fixture.dependencies,
      ),
    ).toThrow(TypeError);
    expect(fixture.providerRequests).toEqual([]);
    expect(fixture.readOtherSecret).not.toHaveBeenCalled();
  });

  it("rejects policy references to an app absent from the catalogue", async () => {
    const fixture = await multiAppFixture();
    expect(() =>
      createGitHubAppTokenExchange(
        {
          ...fixture.configuration,
          githubApps: [fixture.configuration.githubApps[0]],
        },
        fixture.dependencies,
      ),
    ).toThrow("unconfigured GitHub App");
  });
});

const otherKeyPair = generateKeyPair("RS256", { extractable: true });

async function appRequest(
  slug: string,
  claimOverrides: Record<string, unknown> = {},
  scope = "contents:read pull_requests:read",
): Promise<Request> {
  return new Request(
    `https://broker.example/github/apps/${slug}/token`,
    await githubActionsTokenExchangeRequest({ claimOverrides, formOverrides: { scope } }),
  );
}

async function multiAppFixture() {
  const keys = await otherKeyPair;
  const primaryPublicKey = await importJWK(testPublicJwk, "RS256");
  const readPrimarySecret = vi.fn(async () => testPrivateKeyPem);
  const readOtherSecret = vi.fn(async () => exportPKCS8(keys.privateKey));
  const primaryStatement =
    testGitHubActionsTokenExchangeConfiguration.composition.tokenIssuancePolicy.permitStatements[0];
  if (primaryStatement === undefined) throw new Error("missing fixture Permit Statement");
  const configuration = {
    composition: {
      ...testGitHubActionsTokenExchangeConfiguration.composition,
      tokenIssuancePolicy: compileTokenIssuancePolicy([
        primaryStatement,
        {
          ...primaryStatement,
          githubAppClientId: "Iv1.otherApp",
          permissions: { contents: "read", pull_requests: "read" },
        },
      ]),
    },
    githubApps: [
      {
        clientId: "Iv1.fixtureApp",
        slug: "fixture-app",
        privateKey: { get: readPrimarySecret },
        subjectTokenAudiences: ["https://broker.example", "https://primary.example"],
      },
      {
        clientId: "Iv1.otherApp",
        slug: "other-app",
        privateKey: { get: readOtherSecret },
        subjectTokenAudiences: ["https://broker.example", "https://other.example"],
      },
    ],
  } as const satisfies GitHubAppTokenExchangeConfiguration;
  const providerRequests: string[] = [];
  const mints: { clientId: string; body: unknown }[] = [];
  const observations: TokenExchangeObservation[] = [];
  const dependencies = {
    now: () => testNow,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === "token.actions.githubusercontent.com") {
        providerRequests.push(request.url);
        return fetchGitHubActionsTokenExchangeExternalTestDouble(request);
      }
      expect(url.origin).toBe("https://api.github.com");
      const authorization = request.headers.get("authorization");
      if (!authorization?.startsWith("Bearer ")) throw new Error("missing App JWT");
      const jwt = authorization.slice(7);
      const clientId = decodeJwt(jwt).iss;
      if (clientId !== "Iv1.fixtureApp" && clientId !== "Iv1.otherApp")
        throw new Error("unexpected App JWT issuer");
      await jwtVerify(jwt, clientId === "Iv1.fixtureApp" ? primaryPublicKey : keys.publicKey, {
        algorithms: ["RS256"],
        issuer: clientId,
        currentDate: testNow,
      });
      const installationId = clientId === "Iv1.fixtureApp" ? 111 : 222;
      if (
        request.method === "GET" &&
        url.pathname === "/repos/fixture-owner/fixture-source-repository/installation"
      ) {
        return Response.json({ account: { login: "fixture-owner" }, id: installationId });
      }
      expect(url.pathname).toBe(`/app/installations/${installationId}/access_tokens`);
      expect(request.method).toBe("POST");
      const body: unknown = await request.json();
      mints.push({ clientId, body });
      return Response.json(
        {
          expires_at: "2030-01-01T00:00:00Z",
          permissions: { contents: "read", pull_requests: "read" },
          token: `token-${clientId}`,
        },
        { status: 201 },
      );
    },
  };
  const context = {
    observe: async (observation: TokenExchangeObservation) => {
      observations.push(observation);
    },
  };
  return {
    configuration,
    context,
    dependencies,
    exchange: createGitHubAppTokenExchange(configuration, dependencies),
    mints,
    observations,
    providerRequests,
    readOtherSecret,
    readPrimarySecret,
  };
}
