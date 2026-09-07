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
const issuer = "https://token.actions.githubusercontent.com";
const keys = Object.fromEntries(
  ["oidc", "rotated", "untrusted"].map((name) => [name, readFixture(`${name}.pem`)]),
);
const jwk = (name) => ({
  ...createPublicKey(keys[name]).export({ format: "jwk" }),
  kid: name,
  alg: "RS256",
  use: "sig",
});
let mode = "normal";

function jwt(claims, key = "oidc") {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: key === "untrusted" ? "oidc" : key }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuer,
      sub: "integration-subject",
      aud: "urn:integration:broker",
      iat: now,
      exp: now + 300,
      repository: "integration-owner/source",
      ref: "refs/heads/main",
      ...claims,
    }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  return `${data}.${sign("RSA-SHA256", Buffer.from(data), keys[key]).toString("base64url")}`;
}

async function protocol(request, response) {
  assert.equal(request.headers.host, "token.actions.githubusercontent.com");
  assert.equal(request.method, "GET");
  if (request.url === "/.well-known/openid-configuration") {
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
        jwks_uri: `${issuer}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"],
      },
      { "cache-control": mode === "cache" || mode === "rotated" ? "max-age=300" : "no-cache" },
    );
  }
  if (request.url === "/jwks") {
    if (mode === "padded-jwks" || mode === "oversized")
      return sendJson(response, 200, {
        keys: [jwk("oidc")],
        padding: "x".repeat(mode === "oversized" ? 1024 * 1024 : 32 * 1024),
      });
    if (mode === "malformed-jwks")
      return sendJson(response, 200, { keys: [{ kty: "RSA", n: 123 }] });
    if (mode === "malformed-ext")
      return sendJson(response, 200, { keys: [{ ...jwk("oidc"), ext: "invalid" }] });
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
      { keys: [jwk(mode === "rotated" ? "rotated" : "oidc")] },
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
    assert.ok(input.key === undefined || Object.hasOwn(keys, input.key));
    return sendJson(response, 200, { token: jwt(input.claims ?? {}, input.key) });
  }
  sendJson(response, 404, { error: "not_found" });
}

await server.listen(protocol, controls);
