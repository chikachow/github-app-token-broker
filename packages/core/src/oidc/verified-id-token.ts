import type { OidcIssuerIdentifier } from "./provider-registration.ts";

export type ReadonlyJsonValue =
  | boolean
  | null
  | number
  | ReadonlyJsonObject
  | readonly ReadonlyJsonValue[]
  | string;

interface ReadonlyJsonObject {
  readonly [member: string]: ReadonlyJsonValue | undefined;
}

export type VerifiedOidcIdTokenClaims = ReadonlyJsonObject & {
  readonly aud: string;
  readonly exp: number;
  readonly iat: number;
  readonly iss: string;
  readonly sub: string;
};

export interface VerifiedOidcIdToken {
  readonly claims: VerifiedOidcIdTokenClaims;
  readonly issuer: OidcIssuerIdentifier;
  /** Verified ID Token protected-header kid, or null when absent; not the selected JWK identity. */
  readonly idTokenHeaderKeyId: string | null;
}
