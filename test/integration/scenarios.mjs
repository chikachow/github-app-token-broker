import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const oidc = "http://oidc:8081";
const github = "http://github:8081";
const host = process.env.INTEGRATION_HOST;
assert.ok(host === "fastify" || host === "worker", "INTEGRATION_HOST must be fastify or worker");
const broker = "http://broker:8080";
const hostControl = "http://broker:8081";
const request = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
async function control(base, path, input) {
  const response = await request(
    `${base}/${path}`,
    input === undefined
      ? {}
      : {
          method: "POST",
          body: JSON.stringify(input),
          headers: { "content-type": "application/json" },
        },
  );
  assert.equal(response.status, 200, `control ${path}`);
  return response.json();
}
async function reset(oidcMode = "normal", githubMode = "normal") {
  await control(oidc, "scenario", { mode: oidcMode });
  await control(github, "scenario", { mode: githubMode });
}
async function evidence() {
  const states = await Promise.all([control(oidc, "state"), control(github, "state")]);
  for (const state of states) assert.deepEqual(state.failures, [], "upstream contract violations");
  return states.map((state) => state.events);
}
let client = 0;
async function exchange({ claims, key, form = {}, body, method = "POST", ip, suffix = "" } = {}) {
  const { token } = await control(oidc, "subject", { claims, key });
  const response = await request(`${broker}/token`, {
    method,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "cf-connecting-ip": ip ?? `192.0.2.${++client}`,
    },
    ...(method === "GET"
      ? {}
      : {
          body:
            body ??
            new URLSearchParams({
              grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
              subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
              requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
              subject_token: token,
              resource: "https://api.github.com/repos/integration-owner/target",
              scope: "pull_requests:write contents:read contents:read",
              ...form,
            }).toString() + suffix,
          ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
        }),
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.match(response.headers.get("content-type"), /^application\/json\b/u);
  return { status: response.status, body: await response.json() };
}
function success(result) {
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), [
    "access_token",
    "expires_in",
    "issued_token_type",
    "scope",
    "token_type",
  ]);
  assert.equal(result.body.access_token, "ghs_disposable_integration_token");
  assert.equal(result.body.token_type, "Bearer");
  assert.equal(result.body.issued_token_type, "urn:ietf:params:oauth:token-type:access_token");
  assert.equal(result.body.scope, "contents:read pull_requests:write");
  assert.ok(
    Number.isInteger(result.body.expires_in) &&
      result.body.expires_in >= 3500 &&
      result.body.expires_in <= 3600,
  );
}
function failure(result, status, error) {
  assert.deepEqual(result, { status, body: { error } });
}

before(async () => {
  for (const url of [`${oidc}/health`, `${github}/health`, `${hostControl}/health`]) {
    const deadline = Date.now() + 60000;
    while (true) {
      try {
        const response = await request(url);
        await response.arrayBuffer();
        if (response.status === 200) break;
      } catch {
        /* Startup races are bounded by the readiness deadline. */
      }
      assert.ok(Date.now() < deadline, `service did not become ready: ${url}`);
      await delay(250);
    }
  }
});

void describe(host === "worker" ? "Workerd" : "Fastify", { concurrency: false }, () => {
  async function restartHost(profile) {
    const path = profile === undefined ? "reset" : `reset/${profile}`;
    const response = await fetch(`${hostControl}/${path}`, {
      method: "POST",
      signal: AbortSignal.timeout(60000),
    });
    assert.equal(
      response.status,
      204,
      `${host} ${profile ?? "normal"} host must start successfully`,
    );
  }
  beforeEach(() => restartHost());
  void it("rejects the upstream TLS certificate without the test CA", async () => {
    await reset();
    await restartHost("untrusted-ca");
    failure(await exchange(), 503, "temporarily_unavailable");
    assert.deepEqual(await evidence(), [[], []], "TLS rejection must precede HTTP requests");
  });
  for (const [name, mode] of [
    ["exchanges a signed ID Token over TLS and narrows the App-authenticated mint", "normal"],
    ["accepts valid JWKS with additive padding below the response limit", "padded-jwks"],
  ])
    void it(name, async () => {
      await reset(mode);
      success(await exchange());
      const [oidcEvents, githubEvents] = await evidence();
      assert.deepEqual(
        oidcEvents.map((event) => event.path),
        ["/.well-known/openid-configuration", "/jwks"],
      );
      assert.deepEqual(githubEvents, [
        { method: "GET", path: "/repos/integration-owner/target/installation" },
        { method: "POST", path: "/app/installations/12345/access_tokens" },
        {
          kind: "mint",
          body: {
            repositories: ["target"],
            permissions: { contents: "read", pull_requests: "write" },
          },
        },
      ]);
    });
  for (const [name, options, error, noOidc] of [
    ["rejects an invalid signature", { key: "untrusted" }, "invalid_request", false],
    ["rejects expired ID Tokens", { claims: { exp: 1 } }, "invalid_request", false],
    ["requires the exact audience", { claims: { aud: "urn:wrong" } }, "invalid_request", false],
    [
      "applies the GitHub Actions token profile",
      { claims: { azp: "urn:wrong" } },
      "invalid_request",
      false,
    ],
    [
      "denies unpermitted signed Claims",
      { claims: { ref: "refs/heads/untrusted" } },
      "invalid_request",
      false,
    ],
    [
      "does not discover an unregistered issuer",
      { claims: { iss: "https://unregistered.invalid" } },
      "invalid_request",
      true,
    ],
    [
      "denies an unpermitted repository",
      { form: { resource: "https://api.github.com/repos/integration-owner/another" } },
      "invalid_target",
      false,
    ],
    ["denies excess permissions", { form: { scope: "contents:admin" } }, "invalid_scope", false],
    ["requires explicit scope", { form: { scope: "" } }, "invalid_scope", true],
    [
      "rejects duplicate required parameters",
      { suffix: "&grant_type=duplicate" },
      "invalid_request",
      true,
    ],
  ])
    void it(name, async () => {
      await reset();
      failure(await exchange(options), 400, error);
      const [oidcEvents, githubEvents] = await evidence();
      assert.deepEqual(githubEvents, [], "denial must stop before GitHub I/O");
      assert.deepEqual(
        oidcEvents.map((event) => event.path),
        noOidc ? [] : ["/.well-known/openid-configuration", "/jwks"],
      );
    });
  void it("enforces the form body limit across the actual listener", async () => {
    await reset();
    failure(await exchange({ body: `padding=${"x".repeat(65536)}` }), 413, "invalid_request");
    assert.deepEqual(await evidence(), [[], []]);
  });
  void it("enforces the body limit on a chunked request", async () => {
    await reset();
    const body = new ReadableStream({
      start(controller) {
        for (let index = 0; index < 5; index++)
          controller.enqueue(new TextEncoder().encode("x".repeat(16384)));
        controller.close();
      },
    });
    failure(await exchange({ body }), 413, "invalid_request");
    assert.deepEqual(await evidence(), [[], []]);
  });
  if (host === "worker")
    void it("enforces local Worker rate admission before upstream I/O", async () => {
      await reset();
      for (let index = 0; index < 30; index++) {
        failure(await exchange({ body: "", ip: "198.51.100.1" }), 400, "invalid_request");
      }
      failure(await exchange({ body: "", ip: "198.51.100.1" }), 429, "temporarily_unavailable");
      failure(await exchange({ body: "", ip: "198.51.100.2" }), 400, "invalid_request");
      assert.deepEqual(await evidence(), [[], []]);
    });
  void it("normalizes routed unsupported methods", async () => {
    await reset();
    failure(await exchange({ method: "GET" }), 400, "invalid_request");
    assert.deepEqual(await evidence(), [[], []]);
  });
  for (const [mode, status, error] of [
    ["redirect", 503, "temporarily_unavailable"],
    ["unavailable", 503, "temporarily_unavailable"],
    ["bad-issuer", 400, "invalid_request"],
    ["malformed-jwks", 503, "temporarily_unavailable"],
    ["oversized", 503, "temporarily_unavailable"],
  ])
    void it(`fails closed for OIDC ${mode}`, async () => {
      await reset(mode);
      failure(await exchange(), status, error);
      const [oidcEvents, githubEvents] = await evidence();
      assert.deepEqual(
        oidcEvents.map((event) => event.path),
        ["malformed-jwks", "oversized"].includes(mode)
          ? ["/.well-known/openid-configuration", "/jwks"]
          : ["/.well-known/openid-configuration"],
      );
      assert.deepEqual(githubEvents, []);
    });
  for (const [mode, status, error, mint] of [
    ["redirect", 500, "server_error", false],
    ["wrong-owner", 502, "server_error", false],
    ["rate-limit", 503, "temporarily_unavailable", false],
    ["unavailable", 503, "temporarily_unavailable", false],
    ["rejected-mint", 500, "server_error", true],
    ["malformed-mint", 502, "server_error", true],
  ])
    void it(`sanitizes GitHub ${mode} and stops at the expected boundary`, async () => {
      await reset("normal", mode);
      failure(await exchange(), status, error);
      const [, events] = await evidence();
      assert.equal(events.filter((event) => event.kind === "mint").length, mint ? 1 : 0);
      assert.deepEqual(
        events.filter((event) => event.method).map((event) => event.path),
        mint
          ? [
              "/repos/integration-owner/target/installation",
              "/app/installations/12345/access_tokens",
            ]
          : ["/repos/integration-owner/target/installation"],
      );
    });
  for (const [role, mode, minimum] of [
    ["oidc", "stall", 4500],
    ["github", "stall-mint", 9500],
  ])
    void it(
      `bounds ${role} response-body consumption with the real clock`,
      { timeout: 20000 },
      async () => {
        await reset(role === "oidc" ? mode : "normal", role === "github" ? mode : "normal");
        const start = performance.now();
        failure(await exchange(), 503, "temporarily_unavailable");
        const elapsed = performance.now() - start;
        assert.ok(
          elapsed >= minimum && elapsed < minimum + 5000,
          `unexpected deadline duration: ${elapsed}`,
        );
        const [oidcEvents, githubEvents] = await evidence();
        assert.deepEqual(
          oidcEvents.filter((event) => event.method).map((event) => event.path),
          role === "oidc"
            ? ["/.well-known/openid-configuration"]
            : ["/.well-known/openid-configuration", "/jwks"],
        );
        assert.deepEqual(
          githubEvents.filter((event) => event.method).map((event) => event.path),
          role === "oidc"
            ? []
            : [
                "/repos/integration-owner/target/installation",
                "/app/installations/12345/access_tokens",
              ],
        );
      },
    );
  void it("reuses fresh OIDC documents then refreshes an unknown kid after key rotation", async () => {
    await reset("cache");
    success(await exchange());
    await reset("cache");
    success(await exchange());
    const [oidcEvents, githubEvents] = await evidence();
    assert.deepEqual(oidcEvents, [], "fresh cache must avoid OIDC I/O");
    assert.deepEqual(
      githubEvents.filter((event) => event.method).map((event) => event.path),
      ["/repos/integration-owner/target/installation", "/app/installations/12345/access_tokens"],
      "each exchange must mint a new Installation Access Token",
    );
    await reset("rotated");
    failure(await exchange({ key: "rotated" }), 400, "invalid_request");
    assert.deepEqual(await evidence(), [[], []], "unknown-kid cooldown must suppress refresh");
    await delay(10100);
    success(await exchange({ key: "rotated" }));
    const [rotatedOidcEvents, rotatedGitHubEvents] = await evidence();
    assert.deepEqual(rotatedOidcEvents, [{ method: "GET", path: "/jwks" }]);
    assert.deepEqual(
      rotatedGitHubEvents.filter((event) => event.method).map((event) => event.path),
      ["/repos/integration-owner/target/installation", "/app/installations/12345/access_tokens"],
      "the rotated ID Token must authorize a new Installation Access Token",
    );
  });
});
