import type { VerifiedOidcIdTokenClaims } from "./verified-id-token.ts";

declare const oidcIssuerIdentifier: unique symbol;

export type OidcIssuerIdentifier = string & {
  readonly [oidcIssuerIdentifier]: true;
};

const supportedIdTokenSigningAlgorithms = [
  "EdDSA",
  "ES256",
  "ES384",
  "ES512",
  "PS256",
  "PS384",
  "PS512",
  "RS256",
  "RS384",
  "RS512",
] as const;

export type OidcIdTokenSigningAlgorithm = (typeof supportedIdTokenSigningAlgorithms)[number];

export interface OidcIdTokenProfile {
  validate(claims: VerifiedOidcIdTokenClaims): boolean;
}

export interface OidcProviderRegistration {
  readonly acceptedIdTokenSigningAlgorithms: readonly OidcIdTokenSigningAlgorithm[];
  readonly idTokenProfile: OidcIdTokenProfile | null;
  readonly issuer: OidcIssuerIdentifier;
}

const supportedIdTokenSigningAlgorithmSet = new Set<string>(supportedIdTokenSigningAlgorithms);

export function createOidcProviderRegistration(input: {
  acceptedIdTokenSigningAlgorithms: readonly OidcIdTokenSigningAlgorithm[];
  idTokenProfile: OidcIdTokenProfile | null;
  issuer: string;
}): OidcProviderRegistration {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("invalid OIDC Provider Registration");
  }

  const idTokenProfileDescriptor = Object.getOwnPropertyDescriptor(input, "idTokenProfile");

  if (idTokenProfileDescriptor === undefined || !("value" in idTokenProfileDescriptor)) {
    throw new TypeError("invalid OIDC ID Token Profile");
  }

  const idTokenProfileValue: unknown = idTokenProfileDescriptor.value;

  const issuer = typeof input.issuer === "string" ? parseOidcIssuerIdentifier(input.issuer) : null;

  if (issuer === null) {
    throw new TypeError("invalid OIDC Issuer Identifier");
  }

  if (
    !Array.isArray(input.acceptedIdTokenSigningAlgorithms) ||
    input.acceptedIdTokenSigningAlgorithms.length === 0 ||
    new Set(input.acceptedIdTokenSigningAlgorithms).size !==
      input.acceptedIdTokenSigningAlgorithms.length ||
    input.acceptedIdTokenSigningAlgorithms.some(
      (algorithm) => !supportedIdTokenSigningAlgorithmSet.has(algorithm),
    )
  ) {
    throw new TypeError("invalid OIDC ID Token signing algorithm allowlist");
  }

  if (
    idTokenProfileValue !== null &&
    (typeof idTokenProfileValue !== "object" ||
      typeof (idTokenProfileValue as { validate?: unknown }).validate !== "function")
  ) {
    throw new TypeError("invalid OIDC ID Token Profile");
  }

  const idTokenProfile =
    idTokenProfileValue === null ? null : Object.freeze(idTokenProfileValue as OidcIdTokenProfile);

  return Object.freeze({
    acceptedIdTokenSigningAlgorithms: Object.freeze([...input.acceptedIdTokenSigningAlgorithms]),
    idTokenProfile,
    issuer,
  });
}

export function snapshotOidcProviderRegistrations(
  registrations: readonly OidcProviderRegistration[],
): readonly OidcProviderRegistration[] {
  const issuers = new Set<OidcIssuerIdentifier>();
  const snapshot = registrations.map((registration) => {
    const validatedRegistration = createOidcProviderRegistration({
      acceptedIdTokenSigningAlgorithms: registration.acceptedIdTokenSigningAlgorithms,
      idTokenProfile: registration.idTokenProfile,
      issuer: registration.issuer,
    });

    if (issuers.has(validatedRegistration.issuer)) {
      throw new TypeError("duplicate OIDC Provider Registration issuer");
    }

    issuers.add(validatedRegistration.issuer);
    return validatedRegistration;
  });

  return Object.freeze(snapshot);
}

export function isOidcIdTokenSigningAlgorithm(value: string): value is OidcIdTokenSigningAlgorithm {
  return supportedIdTokenSigningAlgorithmSet.has(value);
}

export function parseOidcIssuerIdentifier(value: string): OidcIssuerIdentifier | null {
  if (
    value.length === 0 ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\") ||
    Array.from(value).some((character) => {
      const codeUnit = character.charCodeAt(0);

      return codeUnit <= 0x20 || codeUnit === 0x7f;
    })
  ) {
    return null;
  }

  let issuer: URL;

  try {
    issuer = new URL(value);
  } catch {
    return null;
  }

  if (
    issuer.protocol !== "https:" ||
    issuer.hostname.length === 0 ||
    issuer.username.length !== 0 ||
    issuer.password.length !== 0
  ) {
    return null;
  }

  return value as OidcIssuerIdentifier;
}
