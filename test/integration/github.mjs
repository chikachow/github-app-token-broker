import assert from "node:assert/strict";
import { verify } from "node:crypto";
import {
  createMockServer,
  readFixture,
  readJson,
  sendJson,
  stallResponse,
} from "./mocks/server.mjs";

const server = createMockServer("github");
const appPublicKey = readFixture("app.public.pem");
let mode = "normal";

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
      appPublicKey,
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

async function protocol(request, response) {
  assert.equal(request.headers.host, "api.github.com");
  verifyApp(request);
  if (request.url === "/repos/integration-owner/target/installation") {
    assert.equal(request.method, "GET");
    if (mode === "redirect")
      return sendJson(response, 302, {}, { location: "https://api.github.com/redirect-target" });
    if (mode === "rate-limit")
      return sendJson(
        response,
        403,
        { message: "fixture-rate-limit" },
        { "x-ratelimit-remaining": "0" },
      );
    if (mode === "unavailable") return sendJson(response, 503, { message: "must-not-escape" });
    return sendJson(response, 200, {
      id: 12345,
      account: { login: mode === "wrong-owner" ? "another-owner" : "Integration-Owner" },
    });
  }
  if (request.url === "/app/installations/12345/access_tokens") {
    assert.equal(request.method, "POST");
    assert.equal(request.headers["content-type"], "application/json");
    const mint = await readJson(request);
    // Independent oracle: never import the policy or production request parser here.
    assert.deepEqual(mint, {
      repositories: ["target"],
      permissions: { contents: "read", pull_requests: "write" },
    });
    server.record({ kind: "mint", body: mint });
    if (mode === "rejected-mint") return sendJson(response, 422, { message: "must-not-escape" });
    if (mode === "stall-mint") return stallResponse(response);
    if (mode === "malformed-mint")
      return sendJson(response, 201, { token: "must-not-escape", expires_at: "invalid" });
    return sendJson(response, 201, {
      token: "ghs_disposable_integration_token",
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      permissions: { contents: "read", pull_requests: "write" },
    });
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
        "unavailable",
        "rate-limit",
        "wrong-owner",
        "rejected-mint",
        "stall-mint",
        "malformed-mint",
      ].includes(input.mode),
    );
    mode = input.mode;
    server.reset();
    return sendJson(response, 200, { ready: true });
  }
  sendJson(response, 404, { error: "not_found" });
}

await server.listen(protocol, controls);
