import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { before, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const host = process.env.COMPOSE_PROFILES;
assert.ok(host === "fastify" || host === "worker", "COMPOSE_PROFILES must be fastify or worker");
const project = process.env.COMPOSE_PROJECT_NAME;
assert.match(project ?? "", /^[a-z0-9][a-z0-9_-]*$/u, "COMPOSE_PROJECT_NAME is required");
const compose = (args, env = process.env) =>
  execFileSync(
    "docker",
    [
      "compose",
      "--project-name",
      project,
      "--file",
      "test/integration/compose.yml",
      "--profile",
      host,
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 75000, env },
  );
function endpoint(service, port) {
  const address = compose(["port", service, String(port)]).trim();
  assert.match(address, /^127\.0\.0\.1:\d+$/u, "fixture ports must be loopback-only");
  return `http://${address}`;
}
let oidc;
let github;
let broker;
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

function policyDenialObservationCount(issuer) {
  return compose(["logs", "--no-color", "--no-log-prefix", host])
    .split("\n")
    .filter((line) => {
      let observation;
      try {
        observation = JSON.parse(line);
      } catch {
        return false;
      }
      return (
        observation?.event === "installation_access_token_issuance_failed" &&
        observation?.subject_token?.issuer === issuer &&
        observation?.token_issuance_policy?.outcome === "subject_token_unacceptable"
      );
    }).length;
}

async function assertPolicyDenialObserved(issuer, previousCount) {
  const deadline = Date.now() + 2000;
  while (true) {
    const count = policyDenialObservationCount(issuer);
    if (count !== previousCount) {
      assert.equal(count, previousCount + 1, "the host must record exactly one new policy denial");
      return;
    }
    assert.ok(Date.now() < deadline, "the host must record the authenticated policy denial");
    await delay(25);
  }
}

let clientIpCounter = 0;
function githubActionsExchange(options = {}) {
  return exchange({ ...options, providerFixtureId: "github-actions" });
}
async function exchange({
  providerFixtureId,
  claimOverrides,
  signingKeyName,
  formOverrides = {},
  body,
  method = "POST",
  ip,
  suffix = "",
}) {
  const { token } = await control(oidc, "subject", {
    providerFixtureId,
    claimOverrides,
    signingKeyName,
  });
  const response = await request(`${broker}/token`, {
    method,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "cf-connecting-ip": ip ?? `192.0.2.${++clientIpCounter}`,
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
              ...formOverrides,
            }).toString() + suffix,
          ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
        }),
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.match(response.headers.get("content-type"), /^application\/json\b/u);
  return { status: response.status, body: await response.json() };
}
function success(result, scope = "contents:read pull_requests:write") {
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
  assert.equal(result.body.scope, scope);
  assert.ok(
    Number.isInteger(result.body.expires_in) &&
      result.body.expires_in >= 3500 &&
      result.body.expires_in <= 3600,
  );
}
function failure(result, status, error) {
  assert.deepEqual(result, { status, body: { error } });
}

async function assertSuccessfulGitHubActionsExchange() {
  success(await githubActionsExchange());
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
}
async function assertGitHubActionsExchangeResponseBodyDeadline(role, mode, minimum) {
  await reset(role === "oidc" ? mode : "normal", role === "github" ? mode : "normal");
  const start = performance.now();
  failure(await githubActionsExchange(), 503, "temporarily_unavailable");
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
      : ["/repos/integration-owner/target/installation", "/app/installations/12345/access_tokens"],
  );
}

before(() => {
  oidc = endpoint("oidc", 8081);
  github = endpoint("github", 8081);
});

void describe(host === "worker" ? "Workerd" : "Fastify", { concurrency: false }, () => {
  function restartHost(profile = "normal") {
    compose(["up", "--no-deps", "--force-recreate", "--wait", "--wait-timeout", "60", host], {
      ...process.env,
      INTEGRATION_PROFILE: profile === "observation-failure" ? profile : "normal",
      INTEGRATION_CA_FILE:
        profile === "untrusted-ca" ? "" : "/app/test/integration/.generated/ca.pem",
    });
    broker = endpoint(host, 8080);
  }
  void it("rejects modes belonging to the other mock and clears failed controls on reset", async () => {
    await reset();
    for (const [base, mode] of [
      [oidc, "wrong-owner"],
      [github, "bad-issuer"],
    ]) {
      const response = await request(`${base}/scenario`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "fixture_contract_violation" });
      assert.deepEqual(await control(base, "state"), {
        events: [],
        failures: [{ method: "POST", path: "/scenario" }],
      });
    }
    await reset();
    assert.deepEqual(await evidence(), [[], []]);
  });
  void it("rejects the upstream TLS certificate without the test CA", async () => {
    await reset();
    restartHost("untrusted-ca");
    failure(await githubActionsExchange(), 503, "temporarily_unavailable");
    assert.deepEqual(await evidence(), [[], []], "TLS rejection must precede HTTP requests");
  });
  void it("withholds the token and awaits revocation after failed success observation", async () => {
    await reset("normal", "revocation-gated");
    restartHost("observation-failure");
    let settled = false;
    const pending = githubActionsExchange().finally(() => {
      settled = true;
    });
    try {
      const deadline = Date.now() + 5000;
      while (!(await control(github, "state")).events.some((event) => event.method === "DELETE")) {
        assert.ok(Date.now() < deadline, "broker never attempted revocation");
        await delay(25);
      }
      await delay(50);
      assert.equal(settled, false, "broker must await the revocation response");
    } finally {
      await control(github, "release-revocation", {});
    }
    failure(await pending, 500, "server_error");
    const [, events] = await evidence();
    assert.deepEqual(
      events.filter((event) => event.method).map((event) => [event.method, event.path]),
      [
        ["GET", "/repos/integration-owner/target/installation"],
        ["POST", "/app/installations/12345/access_tokens"],
        ["DELETE", "/installation/token"],
      ],
    );
    assert.deepEqual(events.at(-1), { kind: "revoked" });
  });
  void describe("listener body limits", () => {
    // Wrangler's local proxy can lose the next request after an unread upload.
    beforeEach(() => restartHost());
    void it("enforces the form body limit across the actual listener", async () => {
      await reset();
      failure(
        await githubActionsExchange({ body: `padding=${"x".repeat(65536)}` }),
        413,
        "invalid_request",
      );
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
      failure(await githubActionsExchange({ body }), 413, "invalid_request");
      assert.deepEqual(await evidence(), [[], []]);
    });
  });
  void describe("ordinary deployment", () => {
    // Valid no-cache OIDC documents permit fresh authentication between mock resets.
    before(() => restartHost());
    void it("preserves valid HTTP authentication schemes in rejected Client challenges", async () => {
      await reset();
      for (const scheme of ["1custom", "!custom"]) {
        const response = await request(`${broker}/token`, {
          body: "grant_type=ignored",
          headers: {
            authorization: `${scheme} private-credentials`,
            "content-type": "application/x-www-form-urlencoded",
            "cf-connecting-ip": `192.0.2.${++clientIpCounter}`,
          },
          method: "POST",
        });
        assert.equal(response.status, 401);
        assert.equal(
          response.headers.get("www-authenticate"),
          `${scheme} realm="github-app-token-broker"`,
        );
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("pragma"), "no-cache");
        assert.deepEqual(await response.json(), { error: "invalid_client" });
      }
      assert.deepEqual(await evidence(), [[], []]);
    });
    for (const providerCase of [
      {
        name: "GitHub Actions",
        providerFixtureId: "github-actions",
        issuer: "https://token.actions.githubusercontent.com",
        paths: ["/.well-known/openid-configuration", "/jwks"],
        resource: "https://api.github.com/repos/integration-owner/target",
        scope: "contents:read pull_requests:write",
        nonMatchingClaimOverrides: { ref: "refs/heads/untrusted" },
        repository: "integration-owner/target",
        installationId: 12345,
        permissions: { contents: "read", pull_requests: "write" },
      },
      {
        name: "Buildkite",
        providerFixtureId: "buildkite",
        issuer: "https://agent.buildkite.com",
        paths: ["/.well-known/openid-configuration", "/.well-known/jwks"],
        resource: "https://api.github.com/repos/integration-buildkite-owner/target",
        scope: "contents:write",
        nonMatchingClaimOverrides: { pipeline_id: "33333333-3333-4333-8333-333333333333" },
        repository: "integration-buildkite-owner/target",
        installationId: 67890,
        permissions: { contents: "write" },
      },
      {
        name: "Google service account",
        providerFixtureId: "google-service-account",
        issuer: "https://accounts.google.com",
        paths: ["/.well-known/openid-configuration", "/oauth2/v3/certs"],
        resource: "https://api.github.com/repos/integration-owner/target",
        scope: "contents:read pull_requests:write",
        nonMatchingClaimOverrides: { sub: "107517467455664443766", azp: "107517467455664443766" },
        repository: "integration-owner/target",
        installationId: 12345,
        permissions: { contents: "read", pull_requests: "write" },
      },
      {
        name: "Fly Machine",
        providerFixtureId: "fly-example-org",
        issuer: "https://oidc.fly.io/example-org",
        paths: ["/example-org/.well-known/openid-configuration", "/example-org/.well-known/jwks"],
        resource: "https://api.github.com/repos/integration-owner/target",
        scope: "contents:read pull_requests:write",
        nonMatchingClaimOverrides: { app_name: "other-app" },
        repository: "integration-owner/target",
        installationId: 12345,
        permissions: { contents: "read", pull_requests: "write" },
      },
    ]) {
      const { providerFixtureId, resource, scope, paths } = providerCase;
      void it(`exchanges a ${providerCase.name} ID Token and narrows the Installation Access Token`, async () => {
        await reset();
        success(await exchange({ providerFixtureId, formOverrides: { resource, scope } }), scope);
        const [oidcEvents, githubEvents] = await evidence();
        assert.deepEqual(
          oidcEvents.map((event) => event.path),
          paths,
        );
        assert.deepEqual(githubEvents, [
          { method: "GET", path: `/repos/${providerCase.repository}/installation` },
          {
            method: "POST",
            path: `/app/installations/${providerCase.installationId}/access_tokens`,
          },
          {
            kind: "mint",
            body: { repositories: ["target"], permissions: providerCase.permissions },
          },
        ]);
      });
      void it(`denies Installation Access Token Issuance for ${providerCase.name} before GitHub I/O when selected Claims do not match policy`, async () => {
        await reset();
        const previousPolicyDenials = policyDenialObservationCount(providerCase.issuer);
        failure(
          await exchange({
            providerFixtureId,
            formOverrides: { resource, scope },
            claimOverrides: providerCase.nonMatchingClaimOverrides,
          }),
          400,
          "invalid_request",
        );
        const [oidcEvents, githubEvents] = await evidence();
        assert.deepEqual(
          oidcEvents.map((event) => event.path),
          paths,
        );
        assert.deepEqual(githubEvents, []);
        await assertPolicyDenialObserved(providerCase.issuer, previousPolicyDenials);
      });
    }
    void it("applies the Google profile instead of the GitHub Actions audience relationship", async () => {
      await reset();
      failure(
        await exchange({
          providerFixtureId: "google-service-account",
          claimOverrides: { azp: "urn:integration:broker" },
        }),
        400,
        "invalid_request",
      );
      const [oidcEvents, githubEvents] = await evidence();
      assert.deepEqual(
        oidcEvents.map((event) => event.path),
        ["/.well-known/openid-configuration", "/oauth2/v3/certs"],
      );
      assert.deepEqual(githubEvents, []);
    });
    void it("does not discover another Fly organization based on a token", async () => {
      await reset();
      failure(
        await exchange({
          providerFixtureId: "fly-example-org",
          claimOverrides: { iss: "https://oidc.fly.io/other-org" },
        }),
        400,
        "invalid_request",
      );
      assert.deepEqual(await evidence(), [[], []]);
    });
    for (const [name, options, jwksPath, issuer] of [
      [
        "cannot use GitHub-issued Buildkite claims for a Buildkite permit",
        {
          providerFixtureId: "github-actions",
          claimOverrides: {
            pipeline_id: "55555555-5555-4555-8555-555555555555",
          },
          formOverrides: {
            resource: "https://api.github.com/repos/integration-buildkite-owner/target",
            scope: "contents:write",
          },
        },
        "/jwks",
        "https://token.actions.githubusercontent.com",
      ],
      [
        "cannot use Buildkite-issued GitHub claims for a GitHub permit",
        {
          providerFixtureId: "buildkite",
          claimOverrides: { repository: "integration-owner/source", ref: "refs/heads/main" },
        },
        "/.well-known/jwks",
        "https://agent.buildkite.com",
      ],
    ])
      void it(name, async () => {
        await reset();
        const previousPolicyDenials = policyDenialObservationCount(issuer);
        failure(await exchange(options), 400, "invalid_request");
        const [oidcEvents, githubEvents] = await evidence();
        assert.deepEqual(
          oidcEvents.map((event) => event.path),
          ["/.well-known/openid-configuration", jwksPath],
        );
        assert.deepEqual(githubEvents, [], "denial must stop before GitHub I/O");
        await assertPolicyDenialObserved(issuer, previousPolicyDenials);
      });
    void it("accepts valid JWKS with additive padding below the response limit", async () => {
      await reset("padded-jwks");
      await assertSuccessfulGitHubActionsExchange();
    });
    for (const [name, options, error, noOidc] of [
      ["rejects an invalid signature", { signingKeyName: "untrusted" }, "invalid_request", false],
      ["rejects expired ID Tokens", { claimOverrides: { exp: 1 } }, "invalid_request", false],
      [
        "requires the exact audience",
        { claimOverrides: { aud: "urn:wrong" } },
        "invalid_request",
        false,
      ],
      [
        "applies the GitHub Actions token profile",
        { claimOverrides: { azp: "urn:wrong" } },
        "invalid_request",
        false,
      ],
      [
        "does not discover an unregistered issuer",
        { claimOverrides: { iss: "https://unregistered.invalid" } },
        "invalid_request",
        true,
      ],
      [
        "denies an unpermitted repository",
        { formOverrides: { resource: "https://api.github.com/repos/integration-owner/another" } },
        "invalid_target",
        false,
      ],
      [
        "denies excess permissions",
        { formOverrides: { scope: "contents:admin" } },
        "invalid_scope",
        false,
      ],
      ["requires explicit scope", { formOverrides: { scope: "" } }, "invalid_scope", true],
      [
        "rejects duplicate required parameters",
        { suffix: "&grant_type=duplicate" },
        "invalid_request",
        true,
      ],
    ])
      void it(name, async () => {
        await reset();
        failure(await githubActionsExchange(options), 400, error);
        const [oidcEvents, githubEvents] = await evidence();
        assert.deepEqual(githubEvents, [], "denial must stop before GitHub I/O");
        assert.deepEqual(
          oidcEvents.map((event) => event.path),
          noOidc ? [] : ["/.well-known/openid-configuration", "/jwks"],
        );
      });
    if (host === "worker")
      void it("enforces local Worker rate admission before upstream I/O", async () => {
        await reset();
        for (let index = 0; index < 30; index++) {
          failure(
            await githubActionsExchange({ body: "", ip: "198.51.100.1" }),
            400,
            "invalid_request",
          );
        }
        failure(
          await githubActionsExchange({ body: "", ip: "198.51.100.1" }),
          429,
          "temporarily_unavailable",
        );
        failure(
          await githubActionsExchange({ body: "", ip: "198.51.100.2" }),
          400,
          "invalid_request",
        );
        assert.deepEqual(await evidence(), [[], []]);
      });
    void it("normalizes routed unsupported methods", async () => {
      await reset();
      failure(await githubActionsExchange({ method: "GET" }), 400, "invalid_request");
      assert.deepEqual(await evidence(), [[], []]);
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
        failure(await githubActionsExchange(), status, error);
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
    void it(
      "bounds GitHub response-body consumption with the real clock",
      { timeout: 20000 },
      async () => {
        await assertGitHubActionsExchangeResponseBodyDeadline("github", "stall-mint", 9500);
      },
    );
    void it("closes an unused GitHub error body without awaiting its completion", async () => {
      await reset("normal", "unavailable-body");
      const start = performance.now();
      failure(await githubActionsExchange(), 503, "temporarily_unavailable");
      assert.ok(performance.now() - start < 5000, "classification must not wait for the body");
      const deadline = Date.now() + 2000;
      while (true) {
        const [, events] = await evidence();
        assert.ok(Date.now() < deadline, "the upstream must observe prompt body cancellation");
        if (events.some((event) => event.kind === "response-closed")) {
          assert.deepEqual(
            events.filter((event) => event.method).map((event) => [event.method, event.path]),
            [["GET", "/repos/integration-owner/target/installation"]],
          );
          assert.equal(events.filter((event) => event.kind === "mint").length, 0);
          break;
        }
        await delay(25);
      }
    });
    void it("recovers after ordinary failures and the stalled GitHub response", async () => {
      await reset();
      await assertSuccessfulGitHubActionsExchange();
    });
  });
  void describe("fresh OIDC state", () => {
    // Provider document failures establish backoff that mock resets cannot clear.
    beforeEach(() => restartHost());
    for (const [mode, status, error] of [
      ["redirect", 503, "temporarily_unavailable"],
      ["unavailable", 503, "temporarily_unavailable"],
      ["bad-issuer", 400, "invalid_request"],
      ["malformed-jwks", 503, "temporarily_unavailable"],
      ["malformed-ext", 503, "temporarily_unavailable"],
      ["deeply-nested-jwks", 503, "temporarily_unavailable"],
      ["oversized", 503, "temporarily_unavailable"],
    ])
      void it(`fails closed for OIDC ${mode}`, async () => {
        await reset(mode);
        failure(await githubActionsExchange(), status, error);
        const [oidcEvents, githubEvents] = await evidence();
        assert.deepEqual(
          oidcEvents.map((event) => event.path),
          ["malformed-jwks", "malformed-ext", "deeply-nested-jwks", "oversized"].includes(mode)
            ? ["/.well-known/openid-configuration", "/jwks"]
            : ["/.well-known/openid-configuration"],
        );
        assert.deepEqual(githubEvents, []);
      });
    void it(
      "bounds OIDC response-body consumption with the real clock",
      { timeout: 20000 },
      async () => {
        await assertGitHubActionsExchangeResponseBodyDeadline("oidc", "stall", 4500);
      },
    );
  });
  void it("preserves a stale eligible JWK Set after a malformed ext refresh", async () => {
    await reset("stale-cache");
    restartHost();
    success(await githubActionsExchange());
    await reset("malformed-ext");
    success(await githubActionsExchange());
    const [oidcEvents, githubEvents] = await evidence();
    assert.deepEqual(
      oidcEvents.map((event) => event.path),
      ["/.well-known/openid-configuration", "/jwks"],
      "the malformed refresh must actually reach the provider",
    );
    assert.equal(githubEvents.filter((event) => event.kind === "mint").length, 1);
  });
  void it("reuses fresh OIDC documents then refreshes an unknown kid after key rotation", async () => {
    await reset("cache");
    restartHost();
    success(await githubActionsExchange());
    await reset("cache");
    success(await githubActionsExchange());
    const [oidcEvents, githubEvents] = await evidence();
    assert.deepEqual(oidcEvents, [], "fresh cache must avoid OIDC I/O");
    assert.deepEqual(
      githubEvents.filter((event) => event.method).map((event) => event.path),
      ["/repos/integration-owner/target/installation", "/app/installations/12345/access_tokens"],
      "each exchange must mint a new Installation Access Token",
    );
    await reset("rotated");
    failure(await githubActionsExchange({ signingKeyName: "rotated" }), 400, "invalid_request");
    assert.deepEqual(await evidence(), [[], []], "unknown-kid cooldown must suppress refresh");
    await delay(10100);
    success(await githubActionsExchange({ signingKeyName: "rotated" }));
    const [rotatedOidcEvents, rotatedGitHubEvents] = await evidence();
    assert.deepEqual(rotatedOidcEvents, [{ method: "GET", path: "/jwks" }]);
    assert.deepEqual(
      rotatedGitHubEvents.filter((event) => event.method).map((event) => event.path),
      ["/repos/integration-owner/target/installation", "/app/installations/12345/access_tokens"],
      "the rotated ID Token must authorize a new Installation Access Token",
    );
  });
});
