import {
  flyOidcIntegrationIssuer,
  tokenExchangeOidcIntegrationCases,
} from "./oidc-integration-cases.ts";
import { testPrivateKeyPem, testPublicJwk } from "./rsa-test-key-pair.ts";
import {
  createTokenExchangeRequestBody,
  testGithubActionsIssuer,
  type TokenExchangeRequestBodyOptions,
} from "./oidc-token.ts";

type TokenExchangeOidcIntegrationCase = (typeof tokenExchangeOidcIntegrationCases)[number];

const testGithubActionsProviderConfigurationUrl = `${testGithubActionsIssuer}/.well-known/openid-configuration`;
const testGithubActionsJwksUrl = `${testGithubActionsIssuer}/.well-known/jwks`;

/**
 * Node-only OIDC fixture seam shared by Vitest configuration and deployment validation.
 * The token-exchange Workerd integration module receives only the private-key binding and imports
 * no Node crypto modules.
 */
export const tokenExchangeOidcNodeFixture = Object.freeze({
  githubActions: Object.freeze({
    expectedOutboundUrls: Object.freeze([
      testGithubActionsProviderConfigurationUrl,
      testGithubActionsJwksUrl,
    ]),
    tokenExchangeRequestBody: (options: TokenExchangeRequestBodyOptions = {}): Promise<string> =>
      createTokenExchangeRequestBody(testPrivateKeyPem, options),
  }),
  privateKeyPem: testPrivateKeyPem,
  outboundService: tokenExchangeOidcOutboundService,
});

function tokenExchangeOidcOutboundService(request: Request): Response {
  if (request.method !== "GET") {
    throw new Error(`unexpected outbound request: ${request.method} ${request.url}`);
  }
  if (request.headers.get("accept") !== "application/json") {
    throw new Error(`unexpected outbound accept header: ${request.headers.get("accept")}`);
  }

  if (request.url === testGithubActionsProviderConfigurationUrl) {
    return jsonResponse({
      id_token_signing_alg_values_supported: ["RS256"],
      issuer: testGithubActionsIssuer,
      jwks_uri: testGithubActionsJwksUrl,
    });
  }
  if (request.url === testGithubActionsJwksUrl) {
    return jsonResponse({ keys: [testPublicJwk] });
  }

  for (const testCase of tokenExchangeOidcIntegrationCases) {
    if (request.url === flyOidcIntegrationProviderConfigurationUrl(testCase)) {
      return testCase.scenario === "provider-redirect"
        ? redirectResponse(providerConfigurationRedirectUrl(testCase))
        : jsonResponse(providerConfigurationDocument(testCase));
    }
    if (request.url === flyOidcIntegrationJwksUrl(testCase)) {
      return testCase.scenario === "jwks-redirect"
        ? redirectResponse(redirectJwksUrl(testCase))
        : jsonResponse({ keys: [testPublicJwk] });
    }
    if (request.url === providerConfigurationRedirectUrl(testCase)) {
      return jsonResponse(providerConfigurationDocument(testCase, redirectJwksUrl(testCase)));
    }
    if (request.url === redirectJwksUrl(testCase)) {
      return jsonResponse({ keys: [testPublicJwk] });
    }
  }

  throw new Error(`unexpected outbound request: ${request.method} ${request.url}`);
}

function providerConfigurationDocument(
  testCase: TokenExchangeOidcIntegrationCase,
  jwksUri: string = flyOidcIntegrationJwksUrl(testCase),
) {
  return {
    id_token_signing_alg_values_supported: ["RS256"],
    issuer: flyOidcIntegrationIssuer(testCase),
    jwks_uri: jwksUri,
  };
}

function flyOidcIntegrationProviderConfigurationUrl(
  testCase: TokenExchangeOidcIntegrationCase,
): string {
  return `${flyOidcIntegrationIssuer(testCase)}/.well-known/openid-configuration`;
}

function flyOidcIntegrationJwksUrl(testCase: TokenExchangeOidcIntegrationCase): string {
  return `${flyOidcIntegrationIssuer(testCase)}/.well-known/jwks`;
}

function providerConfigurationRedirectUrl(testCase: TokenExchangeOidcIntegrationCase): string {
  return `https://attacker.example/${testCase.organizationSlug}/provider-configuration`;
}

function redirectJwksUrl(testCase: TokenExchangeOidcIntegrationCase): string {
  return `https://attacker.example/${testCase.organizationSlug}/jwks`;
}

function jsonResponse(body: unknown): Response {
  return Response.json(body, {
    headers: {
      "cache-control": "no-store",
    },
  });
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    headers: { location },
    status: 302,
  });
}
