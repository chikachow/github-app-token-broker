import { describe, expect, it } from "vitest";

import {
  deriveOidcProviderConfigurationUrl,
  OidcProviderMetadataValidationError,
  parseOidcProviderMetadata,
} from "@github-app-token-broker/oidc/provider-metadata";
import {
  createOidcProviderRegistration,
  parseOidcIssuerIdentifier,
} from "@github-app-token-broker/oidc/provider-registration";

const issuer = "https://issuer.example/tenant";
const jwksUri = "https://keys.example/tenant/jwks";
const registration = createOidcProviderRegistration({
  acceptedIdTokenSigningAlgorithms: ["RS256"],
  idTokenProfile: { validate: () => true },
  issuer,
});

describe("OIDC discovery URL derivation", () => {
  it.each([
    ["https://issuer.example", "https://issuer.example/.well-known/openid-configuration"],
    ["https://issuer.example/", "https://issuer.example/.well-known/openid-configuration"],
    [
      "https://issuer.example/tenant",
      "https://issuer.example/tenant/.well-known/openid-configuration",
    ],
    [
      "https://issuer.example/tenant/",
      "https://issuer.example/tenant/.well-known/openid-configuration",
    ],
  ])("appends the OIDC Discovery suffix after the issuer path", (value, expected) => {
    const parsed = parseOidcIssuerIdentifier(value);

    expect(parsed).not.toBeNull();
    expect(deriveOidcProviderConfigurationUrl(parsed!)).toHaveProperty("href", expected);
  });
});

describe("OpenID Provider Configuration validation", () => {
  it("accepts extension members while retaining the consumed metadata", () => {
    const providerMetadata = parseOidcProviderMetadata(
      {
        custom_provider_extension: { enabled: true },
        id_token_signing_alg_values_supported: ["RS256", "ES256"],
        issuer,
        jwks_uri: jwksUri,
      },
      registration,
    );

    expect(providerMetadata).toMatchObject({
      acceptedIdTokenSigningAlgorithms: ["RS256"],
      issuer,
      jwksUri: new URL(jwksUri),
    });
    expect(Object.isFrozen(providerMetadata)).toBe(true);
    expect(Object.isFrozen(providerMetadata.acceptedIdTokenSigningAlgorithms)).toBe(true);
  });

  it("retains the registration order in the accepted signing-algorithm intersection", () => {
    const multipleAlgorithmRegistration = createOidcProviderRegistration({
      acceptedIdTokenSigningAlgorithms: ["ES256", "RS256"],
      idTokenProfile: { validate: () => true },
      issuer,
    });

    expect(
      parseOidcProviderMetadata(
        {
          id_token_signing_alg_values_supported: ["RS256", "ES256", "RS512"],
          issuer,
          jwks_uri: jwksUri,
        },
        multipleAlgorithmRegistration,
      ).acceptedIdTokenSigningAlgorithms,
    ).toEqual(["ES256", "RS256"]);
  });

  it("allows a registration to select ES256 from conformant provider metadata", () => {
    const es256Registration = createOidcProviderRegistration({
      acceptedIdTokenSigningAlgorithms: ["ES256"],
      idTokenProfile: { validate: () => true },
      issuer,
    });

    expect(
      parseOidcProviderMetadata(
        {
          id_token_signing_alg_values_supported: ["RS256", "ES256"],
          issuer,
          jwks_uri: jwksUri,
        },
        es256Registration,
      ).acceptedIdTokenSigningAlgorithms,
    ).toEqual(["ES256"]);
  });

  it.each([
    [null],
    [[]],
    ["not an object"],
    [
      {
        id_token_signing_alg_values_supported: ["RS256"],
        jwks_uri: jwksUri,
      },
    ],
    [
      {
        id_token_signing_alg_values_supported: ["RS256"],
        issuer: 42,
        jwks_uri: jwksUri,
      },
    ],
    [
      {
        id_token_signing_alg_values_supported: ["RS256"],
        issuer,
      },
    ],
    [
      {
        id_token_signing_alg_values_supported: ["RS256"],
        issuer,
        jwks_uri: 42,
      },
    ],
    [
      {
        id_token_signing_alg_values_supported: ["RS256"],
        issuer,
        jwks_uri: "",
      },
    ],
    [
      {
        issuer,
        jwks_uri: jwksUri,
      },
    ],
    [
      {
        id_token_signing_alg_values_supported: "RS256",
        issuer,
        jwks_uri: jwksUri,
      },
    ],
    [
      {
        id_token_signing_alg_values_supported: [],
        issuer,
        jwks_uri: jwksUri,
      },
    ],
    [
      {
        id_token_signing_alg_values_supported: ["RS256", 42],
        issuer,
        jwks_uri: jwksUri,
      },
    ],
    [
      {
        id_token_signing_alg_values_supported: ["RS256", ""],
        issuer,
        jwks_uri: jwksUri,
      },
    ],
    [
      {
        id_token_signing_alg_values_supported: ["ES256"],
        issuer,
        jwks_uri: jwksUri,
      },
    ],
  ] as const)("rejects structurally invalid OpenID Provider Configuration", (input) => {
    expectMetadataError(input);
  });

  it.each([
    "not a URL",
    "http://keys.example/tenant/jwks",
    "https://user@keys.example/tenant/jwks",
    `${jwksUri}#fragment`,
  ])("rejects an invalid HTTPS JWK Set URI", (invalidJwksUri) => {
    expectMetadataError({
      id_token_signing_alg_values_supported: ["RS256"],
      issuer,
      jwks_uri: invalidJwksUri,
    });
  });

  it("requires an exact registered issuer", () => {
    expectMetadataError({
      id_token_signing_alg_values_supported: ["RS256"],
      issuer: `${issuer}/`,
      jwks_uri: jwksUri,
    });
  });

  it("requires an algorithm shared with the registration", () => {
    const incompatibleRegistration = createOidcProviderRegistration({
      acceptedIdTokenSigningAlgorithms: ["ES256"],
      idTokenProfile: { validate: () => true },
      issuer,
    });

    expectMetadataError(
      {
        id_token_signing_alg_values_supported: ["RS256"],
        issuer,
        jwks_uri: jwksUri,
      },
      incompatibleRegistration,
    );
  });
});

function expectMetadataError(input: unknown, providerRegistration = registration): void {
  try {
    parseOidcProviderMetadata(input, providerRegistration);
  } catch (error) {
    expect(error).toBeInstanceOf(OidcProviderMetadataValidationError);
    expect(error).toMatchObject({ code: "ERR_OIDC_METADATA_INVALID" });

    return;
  }

  throw new Error("expected OpenID Provider Configuration validation to fail");
}
