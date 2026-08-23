import { importPKCS8, SignJWT } from "jose";

import type { OidcIdTokenAuthenticationResult } from "@github-app-token-broker/oidc/id-token-authenticator";
import { createOidcProviderRegistration } from "@github-app-token-broker/oidc/provider-registration";
import { parseSubjectTokenAudience } from "@github-app-token-broker/oidc/subject-token-audience";

import { testPrivateKeyPem, testPublicJwk } from "./rsa-test-key-pair.ts";

export const issuer = "https://issuer.example/tenant";
export const jwksUri = "https://keys.example/tenant/jwks";
export const subjectTokenAudience = parseSubjectTokenAudience("github-app-token-broker");
export const authenticationTestNow = new Date("2026-01-01T00:00:00.000Z");
export type AuthenticationFailure = Extract<OidcIdTokenAuthenticationResult, { ok: false }>;
export const registration = createOidcProviderRegistration({
  acceptedIdTokenSigningAlgorithms: ["RS256"],
  idTokenProfile: { validate: () => true },
  issuer,
});

export function expectedFailure(
  kind: AuthenticationFailure["failure"]["kind"],
  diagnosticCode?: string,
  providerHttpStatus?: number,
): AuthenticationFailure {
  if (kind === "provider_unavailable") {
    return {
      failure: {
        diagnostics: {
          ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
          ...(providerHttpStatus === undefined ? {} : { providerHttpStatus }),
        },
        kind,
      },
      ok: false,
    };
  }

  return {
    failure: {
      diagnostics: diagnosticCode === undefined ? {} : { diagnosticCode },
      kind,
    },
    ok: false,
  };
}

export function providerFetch(
  options: {
    cacheControl?: string;
    jwksContentType?: string;
    jwksResponse?: () => Response;
    providerConfigurationResponse?: () => Response;
    advertisedIdTokenSigningAlgorithms?: string[];
  } = {},
): typeof fetch {
  return async (input) => {
    const url = new URL(new Request(input).url);

    if (url.href === `${issuer}/.well-known/openid-configuration`) {
      if (options.providerConfigurationResponse !== undefined) {
        return options.providerConfigurationResponse();
      }

      return Response.json(
        {
          id_token_signing_alg_values_supported: options.advertisedIdTokenSigningAlgorithms ?? [
            "RS256",
          ],
          issuer,
          jwks_uri: jwksUri,
        },
        { headers: { "cache-control": options.cacheControl ?? "max-age=300" } },
      );
    }

    if (url.href === jwksUri) {
      if (options.jwksResponse !== undefined) {
        return options.jwksResponse();
      }

      return new Response(JSON.stringify({ keys: [testPublicJwk] }), {
        headers: {
          "cache-control": options.cacheControl ?? "max-age=300",
          "content-type": options.jwksContentType ?? "application/json",
        },
      });
    }

    return new Response(null, { status: 404 });
  };
}

export const successfulProviderFetch = providerFetch();

export async function signedIdToken(
  options: {
    algorithm?: string;
    audience?: string | string[];
    claims?: Record<string, unknown>;
    expiresInSeconds?: number;
    kid?: string | null;
    tokenIssuer?: string;
  } = {},
): Promise<string> {
  const now = Math.floor(authenticationTestNow.getTime() / 1000);
  const privateKey = await importPKCS8(testPrivateKeyPem, options.algorithm ?? "RS256");

  return new SignJWT({
    aud: options.audience ?? "github-app-token-broker",
    exp: now + (options.expiresInSeconds ?? 300),
    iat: now - 10,
    iss: options.tokenIssuer ?? issuer,
    sub: "subject",
    ...options.claims,
  })
    .setProtectedHeader({
      alg: options.algorithm ?? "RS256",
      ...(options.kid === null ? {} : { kid: options.kid ?? "test-key-1" }),
    })
    .sign(privateKey);
}
