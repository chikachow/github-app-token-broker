import assert from "node:assert/strict";
import { createPublicKey, sign } from "node:crypto";
import {
  createMockServer,
  readFixture,
  readJson,
  sendJson,
  stallResponse,
} from "./mocks/server.mjs";

const server = createMockServer("oidc");
const providerFixtures = {
  "github-actions": {
    issuer: "https://token.actions.githubusercontent.com",
    jwksUri: "https://token.actions.githubusercontent.com/jwks",
    signingKeyName: "github-actions",
    claims: { repository: "integration-owner/source", ref: "refs/heads/main" },
  },
  buildkite: {
    issuer: "https://agent.buildkite.com",
    jwksUri: "https://agent.buildkite.com/.well-known/jwks",
    signingKeyName: "buildkite",
    claims: {
      pipeline_id: "55555555-5555-4555-8555-555555555555",
      azp: "context-with-no-profile-relationship",
    },
  },
  "google-service-account": {
    issuer: "https://accounts.google.com",
    jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
    signingKeyName: "google",
    claims: { sub: "107517467455664443765", azp: "107517467455664443765" },
  },
  "fly-example-org": {
    issuer: "https://oidc.fly.io/example-org",
    jwksUri: "https://oidc.fly.io/example-org/.well-known/jwks",
    signingKeyName: "fly",
    claims: {
      sub: "custom-machine-subject",
      app_name: "integration-app",
      machine_name: null,
      org_name: "different-org",
      azp: "context-with-no-profile-relationship",
    },
  },
};
const keys = Object.fromEntries(
  ["github-actions", "buildkite", "google", "fly", "rotated", "untrusted"].map((name) => [
    name,
    readFixture(`${name}.pem`),
  ]),
);
const jwk = (name) => ({
  ...createPublicKey(keys[name]).export({ format: "jwk" }),
  kid: name,
  alg: "RS256",
  use: "sig",
});
let mode = "normal";

function createProviderIdToken(
  providerFixture,
  claimOverrides,
  signingKeyName = providerFixture.signingKeyName,
) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({
      alg: "RS256",
      kid: signingKeyName === "untrusted" ? providerFixture.signingKeyName : signingKeyName,
    }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: providerFixture.issuer,
      sub: "integration-subject",
      aud: "urn:integration:broker",
      iat: now,
      exp: now + 300,
      ...providerFixture.claims,
      ...claimOverrides,
    }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  return `${data}.${sign("RSA-SHA256", Buffer.from(data), keys[signingKeyName]).toString("base64url")}`;
}

async function protocol(request, response) {
  const url = `https://${request.headers.host}${request.url}`;
  const providerFixture = Object.values(providerFixtures).find(
    (candidate) =>
      url === `${candidate.issuer}/.well-known/openid-configuration` || url === candidate.jwksUri,
  );
  assert.ok(providerFixture, "unexpected provider URL");
  const { issuer } = providerFixture;
  assert.equal(request.method, "GET");
  if (url === `${issuer}/.well-known/openid-configuration`) {
    if (mode === "redirect")
      return sendJson(response, 302, {}, { location: `${issuer}/redirect-target` });
    if (mode === "stall") return stallResponse(response);
    if (mode === "unavailable")
      return sendJson(response, 503, { private_message: "must-not-escape" });
    return sendJson(
      response,
      200,
      {
        issuer: mode === "bad-issuer" ? "https://untrusted.example" : issuer,
        jwks_uri: providerFixture.jwksUri,
        id_token_signing_alg_values_supported: ["RS256"],
      },
      { "cache-control": mode === "cache" || mode === "rotated" ? "max-age=300" : "no-cache" },
    );
  }
  if (url === providerFixture.jwksUri) {
    if (mode === "padded-jwks" || mode === "oversized")
      return sendJson(response, 200, {
        keys: [jwk(providerFixture.signingKeyName)],
        padding: "x".repeat(mode === "oversized" ? 1024 * 1024 : 32 * 1024),
      });
    if (mode === "malformed-jwks")
      return sendJson(response, 200, { keys: [{ kty: "RSA", n: 123 }] });
    if (mode === "malformed-ext")
      return sendJson(response, 200, {
        keys: [{ ...jwk(providerFixture.signingKeyName), ext: "invalid" }],
      });
    if (mode === "deeply-nested-jwks") {
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-cache",
      });
      // Construct JSON text without imposing a fixture serialization depth limit.
      response.end(
        '{"keys":[{"kty":"unsupported","additive":' +
          "[".repeat(4000) +
          "0" +
          "]".repeat(4000) +
          "}]}",
      );
      return;
    }
    return sendJson(
      response,
      200,
      { keys: [jwk(mode === "rotated" ? "rotated" : providerFixture.signingKeyName)] },
      {
        "cache-control":
          mode === "cache" || mode === "rotated"
            ? "max-age=300"
            : mode === "stale-cache"
              ? "max-age=0"
              : "no-cache",
      },
    );
  }
  throw new Error("unexpected upstream request");
}

async function controls(request, response) {
  if (request.method === "POST" && request.url === "/scenario") {
    const input = await readJson(request);
    assert.ok(
      [
        "normal",
        "redirect",
        "stall",
        "unavailable",
        "bad-issuer",
        "cache",
        "stale-cache",
        "rotated",
        "padded-jwks",
        "oversized",
        "malformed-jwks",
        "malformed-ext",
        "deeply-nested-jwks",
      ].includes(input.mode),
    );
    mode = input.mode;
    server.reset();
    return sendJson(response, 200, { ready: true });
  }
  if (request.method === "POST" && request.url === "/subject") {
    const input = await readJson(request);
    assert.ok(input.signingKeyName === undefined || Object.hasOwn(keys, input.signingKeyName));
    const providerFixtureId = input.providerFixtureId;
    assert.ok(Object.hasOwn(providerFixtures, providerFixtureId));
    return sendJson(response, 200, {
      token: createProviderIdToken(
        providerFixtures[providerFixtureId],
        input.claimOverrides ?? {},
        input.signingKeyName,
      ),
    });
  }
  sendJson(response, 404, { error: "not_found" });
}

await server.listen(protocol, controls);
