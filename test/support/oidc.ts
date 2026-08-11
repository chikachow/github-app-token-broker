import { parseOidcIssuerIdentifier } from "@github-app-token-broker/oidc/provider-registration";
import type { VerifiedSubjectToken } from "@github-app-token-broker/oidc/id-token-authenticator";
import {
  createOidcToken,
  createTokenExchangeRequestBody,
  type CreateOidcTokenOptions,
  testGithubActionsIssuer,
  type TokenExchangeRequestBodyOptions,
} from "./oidc-token.ts";
import { testPrivateKeyPem, testPublicJwk } from "./rsa-test-key-pair.ts";

export { githubInstallationAccessTokenType } from "./constants.ts";

export function createVerifiedSubjectToken(
  claims: Partial<VerifiedSubjectToken["claims"]> = {},
  options: { issuer?: string } = {},
): VerifiedSubjectToken {
  const now = Math.floor(Date.now() / 1000);
  const issuer = parseOidcIssuerIdentifier(options.issuer ?? testGithubActionsIssuer);

  if (issuer === null) {
    throw new TypeError("test Verified Subject Token requires a valid OIDC Issuer Identifier");
  }

  return {
    claims: {
      aud: "https://broker.example",
      exp: now + 300,
      iat: now - 10,
      iss: issuer,
      sub: "repo:fixture-owner/fixture-source-repository:ref:refs/heads/fixture-base-branch",
      ...claims,
    },
    issuer,
  };
}

export function authorizationHeaders(
  overrides?: Partial<Record<string, unknown>>,
  tokenOptions?: CreateOidcTokenOptions,
): Promise<Record<string, string>> {
  return createOidcToken(testPrivateKeyPem, overrides, tokenOptions).then((token) => ({
    authorization: `Bearer ${token}`,
  }));
}

export function tokenExchangeRequestBody(
  options: TokenExchangeRequestBodyOptions = {},
): Promise<string> {
  return createTokenExchangeRequestBody(testPrivateKeyPem, options);
}

export async function fetchOidcRemoteDocumentResponseTestDouble(input: RequestInfo | URL) {
  const request = new Request(input);
  const providerMetadata = new Map<string, { issuer: string; jwksUri: string }>([
    [
      "https://token.actions.githubusercontent.com/.well-known/openid-configuration",
      {
        issuer: "https://token.actions.githubusercontent.com",
        jwksUri: "https://token.actions.githubusercontent.com/.well-known/jwks",
      },
    ],
    [
      "https://accounts.google.com/.well-known/openid-configuration",
      {
        issuer: "https://accounts.google.com",
        jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
      },
    ],
    ...["example-org", "first-org", "second-org"].map(
      (organizationSlug) =>
        [
          `https://oidc.fly.io/${organizationSlug}/.well-known/openid-configuration`,
          {
            issuer: `https://oidc.fly.io/${organizationSlug}`,
            jwksUri: `https://oidc.fly.io/${organizationSlug}/.well-known/jwks`,
          },
        ] as const,
    ),
  ]);
  const metadata = providerMetadata.get(request.url);

  if (request.method === "GET" && metadata !== undefined) {
    return Response.json(
      {
        id_token_signing_alg_values_supported: ["RS256"],
        issuer: metadata.issuer,
        jwks_uri: metadata.jwksUri,
      },
      { headers: { "cache-control": "max-age=300" } },
    );
  }

  const supportedJwksUrls = new Set([
    "https://token.actions.githubusercontent.com/.well-known/jwks",
    "https://oidc.fly.io/example-org/.well-known/jwks",
    "https://oidc.fly.io/first-org/.well-known/jwks",
    "https://oidc.fly.io/second-org/.well-known/jwks",
    "https://www.googleapis.com/oauth2/v3/certs",
  ]);

  if (request.method !== "GET" || !supportedJwksUrls.has(request.url)) {
    return new Response(null, { status: 404 });
  }

  return Response.json(
    {
      keys: [testPublicJwk],
    },
    {
      headers: {
        "cache-control": "max-age=300",
      },
    },
  );
}
