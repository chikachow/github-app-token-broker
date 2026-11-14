import * as z from "zod";

import type {
  OidcIdTokenSigningAlgorithm,
  OidcIssuerIdentifier,
  OidcProviderRegistration,
} from "./provider-registration.ts";

export interface ValidatedOidcProviderMetadata {
  readonly acceptedIdTokenSigningAlgorithms: readonly OidcIdTokenSigningAlgorithm[];
  readonly issuer: OidcIssuerIdentifier;
  readonly jwksUri: URL;
}

/**
 * Derives the OpenID Provider Configuration request URL defined by OpenID
 * Connect Discovery 1.0, section 4.1. The suffix is appended after any issuer
 * path; this is intentionally not RFC 8414's insertion-before-path algorithm.
 */
export function deriveOidcProviderConfigurationUrl(issuer: OidcIssuerIdentifier): URL {
  const issuerWithoutTerminatingSlash = issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;

  return new URL(`${issuerWithoutTerminatingSlash}/.well-known/openid-configuration`);
}

export function parseOidcProviderMetadata(
  input: unknown,
  providerRegistration: OidcProviderRegistration,
): ValidatedOidcProviderMetadata {
  const providerMetadata = consumedOidcProviderMetadataSchema.safeParse(input);

  if (!providerMetadata.success) {
    throw new OidcProviderMetadataValidationError();
  }

  if (providerMetadata.data.issuer !== providerRegistration.issuer) {
    throw new OidcProviderMetadataValidationError();
  }

  const jwksUri = parseHttpsUrl(providerMetadata.data.jwks_uri);

  if (jwksUri === null) {
    throw new OidcProviderMetadataValidationError();
  }

  const acceptedIdTokenSigningAlgorithms =
    providerRegistration.acceptedIdTokenSigningAlgorithms.filter((algorithm) =>
      providerMetadata.data.id_token_signing_alg_values_supported.includes(algorithm),
    );

  if (acceptedIdTokenSigningAlgorithms.length === 0) {
    throw new OidcProviderMetadataValidationError();
  }

  return Object.freeze({
    acceptedIdTokenSigningAlgorithms: Object.freeze([...acceptedIdTokenSigningAlgorithms]),
    issuer: providerRegistration.issuer,
    jwksUri,
  });
}

export class OidcProviderMetadataValidationError extends Error {
  public readonly code = "ERR_OIDC_METADATA_INVALID";

  public constructor() {
    super("invalid OpenID Provider Configuration");
    this.name = "OidcProviderMetadataValidationError";
  }
}

function parseHttpsUrl(input: string): URL | null {
  let url: URL;

  try {
    url = new URL(input);
  } catch {
    return null;
  }

  return url.protocol === "https:" &&
    url.hostname.length > 0 &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.hash.length === 0
    ? url
    : null;
}

/**
 * The authenticator consumes only these Discovery metadata members. This is
 * deliberately not complete OpenID Provider Configuration validation: endpoint
 * and capability members unused by ID Token verification, including provider
 * extensions, are accepted without validation.
 */
const consumedOidcProviderMetadataSchema = z.object({
  id_token_signing_alg_values_supported: z
    .array(z.string().min(1))
    .min(1)
    .refine((algorithms) => algorithms.includes("RS256")),
  issuer: z.string().min(1),
  jwks_uri: z.string().min(1),
});
