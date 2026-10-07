import {
  compileGitHubAppTokenExchange,
  snapshotGitHubAppMetadata,
} from "@github-app-token-broker/token-exchange";
import { describe, expect, it, vi } from "vitest";
import {
  fetchGitHubActionsTokenExchangeExternalTestDouble,
  githubActionsTokenExchangeRequest,
  testGitHubActionsTokenExchangeConfiguration as original,
} from "../support/github-actions-token-exchange.ts";
import { testNow } from "../support/constants.ts";
import { testPrivateKeyPem } from "../support/rsa-test-key-pair.ts";

describe("compiled Token Exchange credential binding", () => {
  it("captures metadata, credentials and runtime dependencies without secret I/O", async () => {
    const app: {
      clientId: string;
      slug: string;
      privateKey: string;
      subjectTokenAudiences: string[];
    } = {
      ...original.githubApps[0],
      subjectTokenAudiences: [...original.githubApps[0].subjectTokenAudiences],
    };
    const apps = [app];
    const registrations = [...original.composition.oidcProviderRegistrations];
    const fetch = vi.fn(fetchGitHubActionsTokenExchangeExternalTestDouble);
    const dependencies = { fetch, now: () => testNow };
    const compiled = compileGitHubAppTokenExchange(
      {
        composition: { ...original.composition, oidcProviderRegistrations: registrations },
        githubApps: apps,
      },
      dependencies,
    );
    const get = vi.fn(async () => testPrivateKeyPem);
    const credential = { clientId: app.clientId, privateKey: { get } };
    const bound = compiled.bindPrivateKeys([credential]);
    credential.clientId = "Iv1.changed";
    credential.privateKey = { get: vi.fn(async () => "bad replacement") };
    app.slug = "changed";
    app.subjectTokenAudiences[0] = "urn:changed";
    apps.length = 0;
    registrations.length = 0;
    dependencies.fetch = vi.fn();
    expect(fetch).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.tokenEndpointPaths)).toBe(true);
    expect(bound.tokenEndpointPaths).toBe(compiled.tokenEndpointPaths);
    expect(
      (await bound(await githubActionsTokenExchangeRequest(), { observe: async () => {} })).status,
    ).toBe(200);
    expect(get).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalled();
  });

  it("retains shared verifier state when credentials are rebound and resolves a stable secret binding afresh", async () => {
    let providerDown = false;
    const providerRequests: string[] = [];
    const compiled = compileGitHubAppTokenExchange(original, {
      now: () => testNow,
      fetch: (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).hostname === "token.actions.githubusercontent.com") {
          providerRequests.push(request.url);
          if (providerDown) return Promise.resolve(new Response(null, { status: 503 }));
        }
        return fetchGitHubActionsTokenExchangeExternalTestDouble(request);
      },
    });
    const get = vi.fn(async () => testPrivateKeyPem);
    const credentials = [{ clientId: "Iv1.fixtureApp", privateKey: { get } }];
    const context = { observe: async () => {} };
    expect(
      (
        await compiled.bindPrivateKeys(credentials)(
          await githubActionsTokenExchangeRequest(),
          context,
        )
      ).status,
    ).toBe(200);
    providerDown = true;
    const rebound = compiled.bindPrivateKey("/github/apps/fixture-app/token", credentials[0]!);
    expect((await rebound(await githubActionsTokenExchangeRequest(), context)).status).toBe(200);
    get.mockResolvedValue("invalid replacement key");
    expect((await rebound(await githubActionsTokenExchangeRequest(), context)).status).toBe(500);
    get.mockResolvedValue(testPrivateKeyPem);
    expect((await rebound(await githubActionsTokenExchangeRequest(), context)).status).toBe(200);
    expect(get).toHaveBeenCalledTimes(4);
    expect(providerRequests).toHaveLength(2);
  });

  it.each([
    null,
    {},
    [],
    [null],
    [{ clientId: "Iv1.unknown", privateKey: "unused" }],
    [original.githubApps[0], original.githubApps[0]],
  ])("rejects an ambiguous or incomplete credential inventory %j", (credentials) => {
    const compiled = compileGitHubAppTokenExchange(original);
    expect(() => compiled.bindPrivateKeys(credentials as never)).toThrow(TypeError);
  });

  it("does not renew expired issuer state when credentials are rebound", async () => {
    let now = testNow;
    let providerDown = false;
    let providerRequests = 0;
    const compiled = compileGitHubAppTokenExchange(original, {
      now: () => now,
      fetch: (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).hostname === "token.actions.githubusercontent.com") {
          providerRequests++;
          if (providerDown) return Promise.resolve(new Response(null, { status: 503 }));
        }
        return fetchGitHubActionsTokenExchangeExternalTestDouble(request);
      },
    });
    const context = { observe: async () => {} };
    expect(
      (
        await compiled.bindPrivateKeys(original.githubApps)(
          await githubActionsTokenExchangeRequest(),
          context,
        )
      ).status,
    ).toBe(200);
    providerDown = true;
    now = new Date(testNow.getTime() + 4_000_000);
    const request = await githubActionsTokenExchangeRequest({
      claimOverrides: {
        iat: Math.floor(now.getTime() / 1000) - 10,
        nbf: Math.floor(now.getTime() / 1000) - 10,
        exp: Math.floor(now.getTime() / 1000) + 300,
      },
    });
    const response = await compiled.bindPrivateKey(
      "/github/apps/fixture-app/token",
      original.githubApps[0],
    )(request, context);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "temporarily_unavailable" });
    expect(providerRequests).toBeGreaterThan(2);
  });

  it("binds only matching endpoint credentials and rejects wrong paths without I/O", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const get = vi.fn(async () => testPrivateKeyPem);
    const compiled = compileGitHubAppTokenExchange(original, { fetch, now: () => testNow });
    const path = "/github/apps/fixture-app/token";
    const wrongCredential = {
      clientId: "Iv1.other",
      get privateKey(): string {
        throw new Error("must not inspect mismatched credentials");
      },
    };
    expect(() => compiled.bindPrivateKey(path, wrongCredential)).toThrow(TypeError);
    expect(() =>
      compiled.bindPrivateKey("/github/apps/missing/token", original.githubApps[0]),
    ).toThrow(TypeError);
    const handler = compiled.bindPrivateKey(path, {
      clientId: "Iv1.fixtureApp",
      privateKey: { get },
    });
    expect(Object.isFrozen(handler)).toBe(true);
    expect(
      (
        await handler(new Request("https://broker.example/github/apps/other/token"), {
          observe: async () => {},
        })
      ).status,
    ).toBe(404);
    expect(get).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sanitizes request URL access failures in a selected handler", async () => {
    const compiled = compileGitHubAppTokenExchange(original);
    const handler = compiled.bindPrivateKey(
      "/github/apps/fixture-app/token",
      original.githubApps[0],
    );
    const request = new Request("https://broker.example/github/apps/fixture-app/token");
    Object.defineProperty(request, "url", {
      get() {
        throw new Error("private URL diagnostic");
      },
    });
    const response = await handler(request, { observe: async () => {} });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "server_error" });
  });

  it("validates metadata independently of private-key properties", () => {
    const app = { ...original.githubApps[0] };
    Object.defineProperty(app, "privateKey", {
      get() {
        throw new Error("must not read credentials");
      },
    });
    expect(snapshotGitHubAppMetadata([app])).toEqual([
      { clientId: app.clientId, slug: app.slug, subjectTokenAudiences: app.subjectTokenAudiences },
    ]);
  });
});
