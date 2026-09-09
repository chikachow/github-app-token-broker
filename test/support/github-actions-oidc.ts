import { testPublicJwk } from "./rsa-test-key-pair.ts";

// Remote documents for the explicit GitHub Actions exchange fixture.
export async function fetchGitHubActionsOidcRemoteDocumentTestDouble(input: RequestInfo | URL) {
  const request = new Request(input);
  if (
    request.method === "GET" &&
    request.url === "https://token.actions.githubusercontent.com/.well-known/openid-configuration"
  ) {
    return Response.json(
      {
        id_token_signing_alg_values_supported: ["RS256"],
        issuer: "https://token.actions.githubusercontent.com",
        jwks_uri: "https://token.actions.githubusercontent.com/.well-known/jwks",
      },
      { headers: { "cache-control": "max-age=300" } },
    );
  }

  if (
    request.method !== "GET" ||
    request.url !== "https://token.actions.githubusercontent.com/.well-known/jwks"
  ) {
    return new Response(null, { status: 404 });
  }

  return Response.json(
    { keys: [testPublicJwk] },
    { headers: { "cache-control": "max-age=300", "content-type": "application/json" } },
  );
}
