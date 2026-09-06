import assert from "node:assert/strict";
import { createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";

const role = process.argv[2];
assert.ok(role === "oidc" || role === "github");
const read = (name) => readFileSync(`test/integration/.generated/${name}`, "utf8");
const issuer = "https://token.actions.githubusercontent.com";
const keys = Object.fromEntries(
  ["oidc", "rotated", "untrusted"].map((name) => [name, read(`${name}.pem`)]),
);
const jwk = (name) => ({
  ...createPublicKey(keys[name]).export({ format: "jwk" }),
  kid: name,
  alg: "RS256",
  use: "sig",
});
let mode = "normal";
let events = [];
let failures = [];
let releaseRevocation;
const record = (event) => {
  assert.ok(events.length < 200, "fixture request budget exceeded");
  events.push(event);
};
const json = (response, status, body, headers = {}) => {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-cache",
    ...headers,
  });
  response.end(JSON.stringify(body));
};
async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    assert.ok(size <= 65536, "fixture body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}
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
function verifyApp(request) {
  assert.equal(request.headers.accept, "application/vnd.github+json");
  assert.equal(request.headers["x-github-api-version"], "2022-11-28");
  assert.equal(request.headers["user-agent"], "github-app-token-broker");
  const authorization = request.headers.authorization;
  assert.ok(authorization?.startsWith("Bearer "));
  const [header, payload, signature, extra] = authorization.slice(7).split(".");
  assert.equal(extra, undefined);
  assert.equal(JSON.parse(Buffer.from(header, "base64url")).alg, "RS256");
  assert.ok(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      read("app.public.pem"),
      Buffer.from(signature, "base64url"),
    ),
    "invalid App JWT signature",
  );
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  const now = Date.now() / 1000;
  assert.equal(claims.iss, "123456");
  assert.ok(Number.isInteger(claims.iat) && claims.iat <= now);
  assert.ok(Number.isInteger(claims.exp) && claims.exp > now && claims.exp - claims.iat <= 600);
}
function stall(response) {
  const requestEvents = events;
  response.writeHead(200, { "content-type": "application/json" });
  response.write('{"incomplete":');
  const timeout = setTimeout(() => response.end(), 20000);
  response.once("close", () => {
    clearTimeout(timeout);
    requestEvents.push({ kind: "body-closed" });
  });
}
async function protocol(request, response) {
  record({ method: request.method, path: request.url });
  if (role === "oidc") {
    assert.equal(request.headers.host, "token.actions.githubusercontent.com");
    assert.equal(request.method, "GET");
    if (request.url === "/.well-known/openid-configuration") {
      if (mode === "redirect")
        return json(response, 302, {}, { location: `${issuer}/redirect-target` });
      if (mode === "stall") return stall(response);
      if (mode === "unavailable")
        return json(response, 503, { private_message: "must-not-escape" });
      return json(
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
        return json(response, 200, {
          keys: [jwk("oidc")],
          padding: "x".repeat(mode === "oversized" ? 1024 * 1024 : 32 * 1024),
        });
      if (mode === "malformed-jwks") return json(response, 200, { keys: [{ kty: "RSA", n: 123 }] });
      return json(
        response,
        200,
        { keys: [jwk(mode === "rotated" ? "rotated" : "oidc")] },
        { "cache-control": mode === "cache" || mode === "rotated" ? "max-age=300" : "no-cache" },
      );
    }
  } else {
    assert.equal(request.headers.host, "api.github.com");
    if (request.url === "/installation/token") {
      assert.equal(request.method, "DELETE");
      assert.equal(request.headers.authorization, "Bearer ghs_disposable_integration_token");
      assert.equal(mode, "revocation-gated");
      await new Promise((resolve) => {
        releaseRevocation = resolve;
      });
      record({ kind: "revoked" });
      response.writeHead(204).end();
      return;
    }
    verifyApp(request);
    if (request.url === "/repos/integration-owner/target/installation") {
      assert.equal(request.method, "GET");
      if (mode === "redirect")
        return json(response, 302, {}, { location: "https://api.github.com/redirect-target" });
      if (mode === "rate-limit")
        return json(
          response,
          403,
          { message: "fixture-rate-limit" },
          { "x-ratelimit-remaining": "0" },
        );
      if (mode === "unavailable") return json(response, 503, { message: "must-not-escape" });
      return json(response, 200, {
        id: 12345,
        account: { login: mode === "wrong-owner" ? "another-owner" : "Integration-Owner" },
      });
    }
    if (request.url === "/app/installations/12345/access_tokens") {
      assert.equal(request.method, "POST");
      assert.equal(request.headers["content-type"], "application/json");
      const mint = await body(request);
      // Independent oracle: never import the policy or production request parser here.
      assert.deepEqual(mint, {
        repositories: ["target"],
        permissions: { contents: "read", pull_requests: "write" },
      });
      record({ kind: "mint", body: mint });
      if (mode === "rejected-mint") return json(response, 422, { message: "must-not-escape" });
      if (mode === "stall-mint") return stall(response);
      if (mode === "malformed-mint")
        return json(response, 201, { token: "must-not-escape", expires_at: "invalid" });
      return json(response, 201, {
        token: "ghs_disposable_integration_token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: { contents: "read", pull_requests: "write" },
      });
    }
  }
  throw new Error("unexpected upstream request");
}
function guarded(handler) {
  return (request, response) => {
    void handler(request, response).catch(() => {
      // Never record assertions containing authorization headers or signed tokens.
      failures.push({ method: request.method, path: request.url });
      if (response.headersSent) response.destroy();
      else json(response, 500, { error: "fixture_contract_violation" });
    });
  };
}
const tls = httpsServer(
  { key: read(`${role}.tls.key`), cert: read(`${role}.crt`) },
  guarded(protocol),
);
const control = httpServer(
  guarded(async (request, response) => {
    if (request.method === "GET" && request.url === "/health")
      return json(response, 200, { ready: true });
    if (request.method === "GET" && request.url === "/state")
      return json(response, 200, { events, failures });
    if (role === "github" && request.method === "POST" && request.url === "/release-revocation") {
      releaseRevocation?.();
      releaseRevocation = undefined;
      return json(response, 200, { released: true });
    }
    if (request.method === "POST" && request.url === "/scenario") {
      const input = await body(request);
      assert.ok(
        [
          "normal",
          "revocation-gated",
          "redirect",
          "stall",
          "unavailable",
          "bad-issuer",
          "cache",
          "rotated",
          "padded-jwks",
          "oversized",
          "malformed-jwks",
          "rate-limit",
          "wrong-owner",
          "rejected-mint",
          "stall-mint",
          "malformed-mint",
        ].includes(input.mode),
      );
      mode = input.mode;
      events = [];
      failures = [];
      return json(response, 200, { ready: true });
    }
    if (role === "oidc" && request.method === "POST" && request.url === "/subject") {
      const input = await body(request);
      assert.ok(input.key === undefined || Object.hasOwn(keys, input.key));
      return json(response, 200, { token: jwt(input.claims ?? {}, input.key) });
    }
    json(response, 404, { error: "not_found" });
  }),
);
await Promise.all([
  new Promise((resolve) => tls.listen(443, "0.0.0.0", resolve)),
  new Promise((resolve) => control.listen(8081, "0.0.0.0", resolve)),
]);
console.log(`${role} fixture ready`);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    tls.closeAllConnections();
    control.closeAllConnections();
    tls.close();
    control.close();
  });
