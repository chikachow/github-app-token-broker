import { createPublicKey, verify } from "node:crypto";
import { testPrivateKeyPem, testPublicJwk } from "./rsa-test-key-pair.ts";
import { testGitHubInstallationResponse } from "./github-app-information.ts";
import type { TestOutboundRequest } from "./outbound-request.ts";

export const githubAppInformationNodeFixture = Object.freeze({
  clientId: "Iv1.fixtureApp",
  privateKeyPem: testPrivateKeyPem,
  responseForRequest: githubAppInformationResponse,
});

function githubAppInformationResponse(request: TestOutboundRequest): Response | null {
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== "https://api.github.com") {
    return null;
  }

  if (url.pathname !== "/app/installations/12345") {
    return null;
  }

  if (
    request.headers.get("accept") !== "application/vnd.github+json" ||
    request.headers.get("x-github-api-version") !== "2022-11-28" ||
    !request.headers.get("authorization")?.startsWith("Bearer ")
  ) {
    throw new Error("invalid GitHub App Information request headers");
  }

  const jwt = request.headers.get("authorization")?.slice(7);
  if (jwt === undefined) throw new Error("missing App JWT");
  const [header, payload, signature] = jwt.split(".");
  if (
    header === undefined ||
    payload === undefined ||
    signature === undefined ||
    !verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      createPublicKey({ key: testPublicJwk, format: "jwk" }),
      Buffer.from(signature, "base64url"),
    )
  ) {
    throw new Error("invalid App JWT signature");
  }
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { iss?: unknown };
  if (claims.iss !== "Iv1.fixtureApp" && claims.iss !== "Iv1.otherApp")
    throw new Error("unconfigured App JWT issuer");
  return Response.json({
    ...testGitHubInstallationResponse,
    app_id: claims.iss === "Iv1.fixtureApp" ? 2419473 : 7654321,
  });
}
