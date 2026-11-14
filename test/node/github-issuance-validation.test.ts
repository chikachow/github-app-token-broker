import { issueInstallationAccessToken } from "@github-app-token-broker/github/app";
import { createInstallationAccessTokenRequest } from "@github-app-token-broker/github/installation-access-token-request";
import { describe, expect, it } from "vitest";

import { testPrivateKeyPem } from "../support/rsa-test-key-pair.ts";

const now = new Date("2026-11-14T00:00:00.000Z");
const mintedToken = "synthetic-validation-token";
const validResponse = {
  expires_at: "2026-11-14T01:00:00.000Z",
  permissions: { contents: "read", issues: "write" },
  token: mintedToken,
};

describe("GitHub issuance response validation", () => {
  it.each([
    { label: "missing permission", replacement: { permissions: { contents: "read" } } },
    {
      label: "weaker permission",
      replacement: { permissions: { contents: "read", issues: "read" } },
    },
    {
      label: "stronger permission",
      replacement: { permissions: { contents: "write", issues: "write" } },
    },
    {
      label: "additional permission",
      replacement: { permissions: { contents: "read", issues: "write", metadata: "read" } },
    },
    {
      label: "additional prototype-named permission",
      replacement: {
        permissions: Object.fromEntries([
          ["contents", "read"],
          ["issues", "write"],
          ["__proto__", "read"],
        ]),
      },
    },
    { label: "missing permission evidence", replacement: { permissions: undefined } },
    { label: "invalid permission evidence", replacement: { permissions: [] } },
    { label: "expired token", replacement: { expires_at: "2026-11-13T23:59:59.000Z" } },
    { label: "subsecond token lifetime", replacement: { expires_at: "2026-11-14T00:00:00.999Z" } },
    { label: "invalid expiration", replacement: { expires_at: "not-a-date" } },
    { label: "missing expiration", replacement: { expires_at: undefined } },
    { label: "empty repository inventory", replacement: { repositories: [] } },
    {
      label: "another repository",
      replacement: { repositories: [{ name: "other", owner: { login: "fixture-owner" } }] },
    },
    {
      label: "another owner",
      replacement: { repositories: [{ name: "fixture-repository", owner: { login: "other" } }] },
    },
    {
      label: "extra repository",
      replacement: {
        repositories: [
          { name: "fixture-repository", owner: { login: "fixture-owner" } },
          { name: "other", owner: { login: "fixture-owner" } },
        ],
      },
    },
    { label: "malformed repository inventory", replacement: { repositories: null } },
    { label: "missing repository identity", replacement: { repositories: [{ id: 123 }] } },
  ])("revokes and rejects a known token with $label", async ({ replacement }) => {
    const requests: Request[] = [];
    const result = await issue({ ...validResponse, ...replacement }, requests);

    expect(result).toMatchObject({
      error: { name: "GitHubApiError", status: 502, upstreamStatus: 201 },
      installationId: 123,
      ok: false,
      reason: "upstream_failure",
      revocationOutcome: "succeeded",
    });
    expect(JSON.stringify(result)).not.toContain(mintedToken);
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["GET", "/repos/fixture-owner/fixture-repository/installation"],
      ["POST", "/app/installations/123/access_tokens"],
      ["DELETE", "/installation/token"],
    ]);
    expect(requests[2]?.headers.get("authorization")).toBe(`Bearer ${mintedToken}`);
    expect(requests[2]?.redirect).toBe("manual");
  });

  it("awaits revocation and contains its failure without returning the credential", async () => {
    const revocationStarted = Promise.withResolvers<void>();
    const revocation = Promise.withResolvers<Response>();
    let completed = false;
    const result = issue({ ...validResponse, permissions: {} }, [], () => {
      revocationStarted.resolve();
      return revocation.promise;
    }).then((value) => {
      completed = true;
      return value;
    });

    await Promise.race([
      revocationStarted.promise,
      result.then(() => {
        throw new Error("issuance completed before revocation");
      }),
    ]);
    expect(completed).toBe(false);
    revocation.reject(new Error(`private revocation failure ${mintedToken}`));
    const failure = await result;
    expect(failure).toMatchObject({
      error: { status: 502, upstreamStatus: 201 },
      ok: false,
      reason: "upstream_failure",
      revocationOutcome: "failed",
    });
    expect(JSON.stringify(failure)).not.toContain(mintedToken);
    expect(JSON.stringify(failure)).not.toContain("private revocation failure");
  });

  it("revokes a recovered token when the clock fails during validation", async () => {
    const requests: Request[] = [];
    const result = await issue(validResponse, requests, undefined, () => {
      if (requests.some((request) => request.method === "POST")) {
        throw new Error(`private clock failure ${mintedToken}`);
      }
      return now;
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "internal_failure",
      revocationOutcome: "succeeded",
    });
    expect(requests.map((request) => request.method)).toEqual(["GET", "POST", "DELETE"]);
    expect(requests[2]?.headers.get("authorization")).toBe(`Bearer ${mintedToken}`);
    expect(JSON.stringify(result)).not.toContain(mintedToken);
    expect(JSON.stringify(result)).not.toContain("private clock failure");
  });

  it.each([undefined, "", 123])(
    "does not attempt revocation without a known token (%s)",
    async (token) => {
      const requests: Request[] = [];
      const result = await issue({ ...validResponse, token }, requests);
      expect(result).toMatchObject({ ok: false, reason: "upstream_failure" });
      expect(result).not.toHaveProperty("revocationOutcome");
      expect(requests.map((request) => request.method)).toEqual(["GET", "POST"]);
    },
  );

  it.each([
    { label: "omitted repository inventory", replacement: {} },
    {
      label: "exact repository with additive fields and case-insensitive identity",
      replacement: {
        repositories: [
          { name: "FIXTURE-REPOSITORY", owner: { login: "FIXTURE-OWNER", id: 456 }, id: 789 },
        ],
        repository_selection: "all",
        future_field: { ignored: true },
      },
    },
    {
      label: "one whole second remaining",
      replacement: { expires_at: "2026-11-14T00:00:01.000Z" },
    },
  ])("accepts $label", async ({ replacement }) => {
    const requests: Request[] = [];
    const result = await issue({ ...validResponse, ...replacement }, requests);
    expect(result).toMatchObject({ ok: true, token: mintedToken });
    expect(requests.map((request) => request.method)).toEqual(["GET", "POST"]);
  });
});

function issue(
  response: unknown,
  requests: Request[],
  revoke: () => Promise<Response> = async () => new Response(null, { status: 204 }),
  getNow: () => Date = () => now,
) {
  return issueInstallationAccessToken(
    { clientId: "Iv1.fixtureApp", privateKey: testPrivateKeyPem },
    createInstallationAccessTokenRequest({
      owner: "fixture-owner",
      repository: "fixture-repository",
      permissions: { contents: "read", issues: "write" },
    }),
    {
      now: getNow,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "GET") {
          return Response.json({ account: { login: "fixture-owner" }, id: 123 });
        }
        if (request.method === "DELETE") return revoke();
        expect(await request.json()).toEqual({
          permissions: { contents: "read", issues: "write" },
          repositories: ["fixture-repository"],
        });
        return Response.json(response, { status: 201 });
      },
    },
  );
}
