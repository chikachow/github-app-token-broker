import { decodeJwt } from "jose";

import {
  createRegisteredOidcProviderVerifier,
  type RegisteredOidcProviderVerifier,
} from "./registered-provider-verifier.ts";
import {
  snapshotOidcProviderRegistrations,
  type OidcIssuerIdentifier,
  type OidcProviderRegistration,
} from "./provider-registration.ts";
import type { SubjectTokenAudience } from "./subject-token-audience.ts";
import type { VerifiedOidcIdTokenClaims } from "./verified-id-token.ts";

export interface OidcIdTokenAuthenticationTrust {
  readonly providerRegistrations: readonly OidcProviderRegistration[];
  readonly subjectTokenAudience: SubjectTokenAudience;
}

export interface VerifiedSubjectToken {
  readonly claims: VerifiedOidcIdTokenClaims;
  readonly issuer: OidcIssuerIdentifier;
}

export interface OidcVerificationEvidence {
  readonly resolvedKeyId: string | null;
}

interface OidcIdTokenAuthenticationSuccess {
  readonly ok: true;
  readonly verificationEvidence: OidcVerificationEvidence;
  readonly verifiedSubjectToken: VerifiedSubjectToken;
}

interface OidcIdTokenRejectionDiagnostics {
  readonly diagnosticCode?: string;
}

interface OidcIdTokenProviderFailureDiagnostics {
  readonly diagnosticCode?: string;
  readonly providerHttpStatus?: number;
}

interface OidcIdTokenInternalFailureDiagnostics {
  readonly diagnosticCode?: string;
}

export type OidcIdTokenAuthenticationFailure =
  | {
      readonly diagnostics: OidcIdTokenInternalFailureDiagnostics;
      readonly kind: "internal_failure";
    }
  | {
      readonly diagnostics: OidcIdTokenProviderFailureDiagnostics;
      readonly kind: "provider_unavailable";
    }
  | {
      readonly diagnostics: OidcIdTokenRejectionDiagnostics;
      readonly kind: "subject_token_rejected";
    };

interface OidcIdTokenAuthenticationFailureResult {
  readonly failure: OidcIdTokenAuthenticationFailure;
  readonly ok: false;
}

export type OidcIdTokenAuthenticationResult =
  | OidcIdTokenAuthenticationFailureResult
  | OidcIdTokenAuthenticationSuccess;

export interface OidcIdTokenAuthenticator {
  authenticateIdToken(
    idToken: string,
    observe?: (event: OidcIdTokenAuthenticationEvent) => void,
  ): Promise<OidcIdTokenAuthenticationResult>;
}

export interface OidcIdTokenAuthenticatorDependencies {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly observe?: ((event: OidcIdTokenAuthenticationEvent) => void) | undefined;
}

export type OidcIdTokenAuthenticationEvent =
  | {
      readonly freshUntil: string;
      readonly metadataGeneration?: number;
      readonly remoteDocumentKind: "jwk_set" | "provider_configuration";
      readonly event: "oidc_remote_document_stale_used";
      readonly issuer: OidcIssuerIdentifier;
      readonly staleUntil: string;
    }
  | {
      readonly event: "oidc_jwk_set_refresh_suppressed";
      readonly issuer: OidcIssuerIdentifier;
      readonly jwkSetHost: string;
      readonly metadataGeneration: number;
    }
  | {
      readonly event: "oidc_provider_jwks_uri_changed";
      readonly issuer: OidcIssuerIdentifier;
      readonly jwkSetHost: string;
      readonly metadataGeneration: number;
      readonly previousJwkSetHost: string;
    }
  | {
      readonly remoteDocumentKind: "jwk_set" | "provider_configuration";
      readonly diagnosticCode?: string;
      readonly event: "oidc_remote_document_refresh_failed";
      readonly freshUntil?: string;
      readonly issuer: OidcIssuerIdentifier;
      readonly metadataGeneration?: number;
      readonly providerHttpStatus?: number;
      readonly staleUntil?: string;
    }
  | {
      readonly event: "oidc_provider_configuration_refreshed";
      readonly freshUntil: string;
      readonly issuer: OidcIssuerIdentifier;
      readonly jwkSetHost: string;
      readonly metadataGeneration: number;
      readonly staleUntil: string;
    };

class OidcIdTokenAuthenticatorImplementation implements OidcIdTokenAuthenticator {
  readonly #defaultObserve: ((event: OidcIdTokenAuthenticationEvent) => void) | undefined;
  readonly #verifierByIssuer: ReadonlyMap<OidcIssuerIdentifier, RegisteredOidcProviderVerifier>;

  public constructor(
    trust: OidcIdTokenAuthenticationTrust,
    dependencies: OidcIdTokenAuthenticatorDependencies,
  ) {
    const verifierByIssuer = new Map<OidcIssuerIdentifier, RegisteredOidcProviderVerifier>();

    for (const providerRegistration of snapshotOidcProviderRegistrations(
      trust.providerRegistrations,
    )) {
      verifierByIssuer.set(
        providerRegistration.issuer,
        createRegisteredOidcProviderVerifier({
          dependencies: {
            fetch: dependencies.fetch,
            now: dependencies.now,
          },
          providerRegistration,
          subjectTokenAudience: trust.subjectTokenAudience,
        }),
      );
    }

    this.#defaultObserve = dependencies.observe;
    this.#verifierByIssuer = verifierByIssuer;
  }

  public async authenticateIdToken(
    idToken: string,
    observe: ((event: OidcIdTokenAuthenticationEvent) => void) | undefined = this.#defaultObserve,
  ): Promise<OidcIdTokenAuthenticationResult> {
    const unverifiedIssuer = issuerClaimWithoutVerification(idToken);

    if (unverifiedIssuer === null) {
      return subjectTokenRejected("ERR_JWT_INVALID");
    }

    const verifier = this.#verifierByIssuer.get(unverifiedIssuer as OidcIssuerIdentifier);

    if (verifier === undefined) {
      return subjectTokenRejected("ERR_OIDC_ISSUER_NOT_REGISTERED");
    }

    return verifier.verifyIdToken(idToken, observe);
  }
}

export function createOidcIdTokenAuthenticator(
  trust: OidcIdTokenAuthenticationTrust,
  dependencies: OidcIdTokenAuthenticatorDependencies,
): OidcIdTokenAuthenticator {
  return new OidcIdTokenAuthenticatorImplementation(trust, dependencies);
}

function subjectTokenRejected(diagnosticCode: string): OidcIdTokenAuthenticationFailureResult {
  return {
    failure: {
      diagnostics: { diagnosticCode },
      kind: "subject_token_rejected",
    },
    ok: false,
  };
}

function issuerClaimWithoutVerification(idToken: string): string | null {
  try {
    const issuer = decodeJwt(idToken).iss;

    return typeof issuer === "string" && issuer.length > 0 ? issuer : null;
  } catch {
    return null;
  }
}
