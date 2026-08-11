import { readBodyUpTo } from "@github-app-token-broker/http/body";
import {
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  errors,
  importJWK,
  jwtVerify,
  type JWK,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";
import * as z from "zod";

import {
  deriveOidcProviderConfigurationUrl,
  OidcProviderMetadataValidationError,
  parseOidcProviderMetadata,
  type ValidatedOidcProviderMetadata,
} from "./provider-metadata.ts";
import {
  createOidcProviderRegistration,
  isOidcIdTokenSigningAlgorithm,
  type OidcIssuerIdentifier,
  type OidcIdTokenSigningAlgorithm,
  type OidcProviderRegistration,
} from "./provider-registration.ts";
import type { VerifiedOidcIdToken, VerifiedOidcIdTokenClaims } from "./verified-id-token.ts";

const providerConfigurationResponseByteLimit = 64 * 1024;
const jwksResponseByteLimit = 256 * 1024;
const jwksKeyCountLimit = 200;
const defaultFreshnessSeconds = 300;
const maximumFreshnessSeconds = 3600;
const staleIfProviderUnavailableSeconds = 3600;
const providerRequestTimeoutMilliseconds = 5000;
const jwksRefreshCooldownMilliseconds = 10_000;
const providerFailureBackoffMilliseconds = 10_000;
const verifiedOidcIdTokenClaimsSchema = z.looseObject({
  aud: z.string(),
  exp: z.number(),
  iat: z.number(),
  iss: z.string().min(1),
  sub: z.string().min(1),
});
const verificationJwkShapeByAlgorithm = {
  EdDSA: { crv: "Ed25519", kty: "OKP" },
  ES256: { crv: "P-256", kty: "EC" },
  ES384: { crv: "P-384", kty: "EC" },
  ES512: { crv: "P-521", kty: "EC" },
  PS256: { kty: "RSA" },
  PS384: { kty: "RSA" },
  PS512: { kty: "RSA" },
  RS256: { kty: "RSA" },
  RS384: { kty: "RSA" },
  RS512: { kty: "RSA" },
} as const satisfies Record<
  OidcIdTokenSigningAlgorithm,
  { readonly crv?: string; readonly kty: string }
>;

export interface OidcIdTokenAuthenticationTrust {
  readonly providerRegistrations: readonly OidcProviderRegistration[];
  readonly subjectTokenAudience: string;
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
  authenticateIdToken(idToken: string): Promise<OidcIdTokenAuthenticationResult>;
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

interface CacheEntry<Value> {
  readonly cacheable: boolean;
  readonly freshUntil: number;
  readonly staleUntil: number;
  readonly value: Value;
}

interface ProviderState {
  jwks?: CacheEntry<CachedJwks> | undefined;
  jwksFailure?: JwksRefreshFailure | undefined;
  jwksRefreshAllowedAfter?: number | undefined;
  jwksRefresh?: JwksRefresh | undefined;
  metadata?: CacheEntry<ValidatedOidcProviderMetadata> | undefined;
  metadataFailure?: ProviderRefreshFailure | undefined;
  /** Isolate-local count of successfully published Provider Configuration refreshes. */
  metadataGeneration: number;
  metadataRefresh?: Promise<ValidatedOidcProviderMetadata> | undefined;
}

interface JwksRefresh {
  readonly identity: JwksResolutionIdentity;
  readonly result: Promise<CacheEntry<CachedJwks>>;
}

interface ProviderRefreshFailure {
  readonly error: unknown;
  readonly retryAfter: number;
}

interface JwksRefreshFailure extends ProviderRefreshFailure {
  readonly identity: JwksResolutionIdentity;
}

interface CachedJwks {
  readonly getKey: JWTVerifyGetKey;
  readonly identity: JwksResolutionIdentity;
}

interface JwksResolutionIdentity {
  readonly acceptedIdTokenSigningAlgorithmsFingerprint: string;
  readonly jwksUri: string;
}

class OidcIdTokenAuthenticatorImplementation implements OidcIdTokenAuthenticator {
  readonly #dependencies: OidcIdTokenAuthenticatorDependencies;
  readonly #providerRegistrations: ReadonlyMap<OidcIssuerIdentifier, OidcProviderRegistration>;
  readonly #providerStates = new Map<OidcIssuerIdentifier, ProviderState>();
  readonly #subjectTokenAudience: string;

  public constructor(
    trust: OidcIdTokenAuthenticationTrust,
    dependencies: OidcIdTokenAuthenticatorDependencies,
  ) {
    if (trust.subjectTokenAudience.length === 0) {
      throw new TypeError("OIDC ID Token authentication subject-token audience must not be empty");
    }

    const providerRegistrations = new Map<OidcIssuerIdentifier, OidcProviderRegistration>();

    for (const unvalidatedProviderRegistration of trust.providerRegistrations) {
      const providerRegistration = createOidcProviderRegistration({
        acceptedIdTokenSigningAlgorithms:
          unvalidatedProviderRegistration.acceptedIdTokenSigningAlgorithms,
        idTokenProfile: unvalidatedProviderRegistration.idTokenProfile,
        issuer: unvalidatedProviderRegistration.issuer,
      });

      if (providerRegistrations.has(providerRegistration.issuer)) {
        throw new TypeError("duplicate OIDC Provider Registration issuer");
      }

      providerRegistrations.set(providerRegistration.issuer, providerRegistration);
      this.#providerStates.set(providerRegistration.issuer, { metadataGeneration: 0 });
    }

    this.#dependencies = dependencies;
    this.#providerRegistrations = providerRegistrations;
    this.#subjectTokenAudience = trust.subjectTokenAudience;
  }

  public async authenticateIdToken(idToken: string): Promise<OidcIdTokenAuthenticationResult> {
    const unverifiedIssuer = issuerClaimWithoutVerification(idToken);

    if (unverifiedIssuer === null) {
      return subjectTokenRejected("ERR_JWT_INVALID");
    }

    const providerRegistration = this.#providerRegistrations.get(
      unverifiedIssuer as OidcIssuerIdentifier,
    );

    if (providerRegistration === undefined) {
      return subjectTokenRejected("ERR_OIDC_ISSUER_NOT_REGISTERED");
    }

    const providerState = this.#providerStates.get(providerRegistration.issuer);

    if (providerState === undefined) {
      return internalFailure("ERR_OIDC_PROVIDER_STATE_MISSING");
    }

    try {
      const providerMetadata = await this.#providerMetadata(providerRegistration, providerState);
      const acceptedIdTokenSigningAlgorithms = providerMetadata.acceptedIdTokenSigningAlgorithms;
      const protectedHeader = decodeProtectedHeader(idToken);

      if (
        typeof protectedHeader.alg !== "string" ||
        !isOidcIdTokenSigningAlgorithm(protectedHeader.alg) ||
        !acceptedIdTokenSigningAlgorithms.includes(protectedHeader.alg)
      ) {
        return subjectTokenRejected("ERR_JOSE_ALG_NOT_ALLOWED");
      }

      let cachedJwks = await this.#remoteJwks(providerMetadata, providerState, false);
      let verifiedIdToken: VerifiedOidcIdToken;

      try {
        verifiedIdToken = await verifyIdToken({
          acceptedIdTokenSigningAlgorithms,
          cachedJwks,
          providerRegistration,
          idToken,
          subjectTokenAudience: this.#subjectTokenAudience,
        });
      } catch (error) {
        if (!hasJoseErrorCode(error, "ERR_JWKS_NO_MATCHING_KEY")) {
          throw error;
        }

        cachedJwks = await this.#remoteJwks(providerMetadata, providerState, true);
        verifiedIdToken = await verifyIdToken({
          acceptedIdTokenSigningAlgorithms,
          cachedJwks,
          providerRegistration,
          idToken,
          subjectTokenAudience: this.#subjectTokenAudience,
        });
      }

      if (
        providerRegistration.idTokenProfile !== null &&
        !providerRegistration.idTokenProfile.validate(verifiedIdToken.claims)
      ) {
        return subjectTokenRejected("ERR_OIDC_ID_TOKEN_PROFILE_REJECTED");
      }

      return {
        ok: true,
        verificationEvidence: {
          resolvedKeyId: verifiedIdToken.resolvedKeyId,
        },
        verifiedSubjectToken: {
          claims: verifiedIdToken.claims,
          issuer: verifiedIdToken.issuer,
        },
      };
    } catch (error) {
      return classifyAuthenticationError(error);
    }
  }

  async #providerMetadata(
    providerRegistration: OidcProviderRegistration,
    providerState: ProviderState,
  ): Promise<ValidatedOidcProviderMetadata> {
    const now = this.#dependencies.now().getTime();

    if (providerState.metadata !== undefined && now < providerState.metadata.freshUntil) {
      return providerState.metadata.value;
    }

    if (
      providerState.metadataFailure !== undefined &&
      now < providerState.metadataFailure.retryAfter
    ) {
      if (
        providerState.metadataFailure.error instanceof OidcRemoteDocumentError &&
        providerState.metadata !== undefined &&
        now < providerState.metadata.staleUntil
      ) {
        this.#observeStaleOidcRemoteDocument(
          providerRegistration.issuer,
          "provider_configuration",
          providerState.metadata,
          providerState.metadataGeneration,
        );

        return providerState.metadata.value;
      }

      throw providerState.metadataFailure.error;
    }

    if (providerState.metadataRefresh === undefined) {
      providerState.metadataRefresh = this.#refreshAndPublishProviderMetadata(
        providerRegistration,
        providerState,
        now,
      );
    }

    try {
      return await providerState.metadataRefresh;
    } catch (error) {
      if (
        error instanceof OidcRemoteDocumentError &&
        providerState.metadata !== undefined &&
        now < providerState.metadata.staleUntil
      ) {
        this.#observeStaleOidcRemoteDocument(
          providerRegistration.issuer,
          "provider_configuration",
          providerState.metadata,
          providerState.metadataGeneration,
        );

        return providerState.metadata.value;
      }

      throw error;
    }
  }

  async #refreshAndPublishProviderMetadata(
    providerRegistration: OidcProviderRegistration,
    providerState: ProviderState,
    now: number,
  ): Promise<ValidatedOidcProviderMetadata> {
    try {
      const refreshed = await this.#fetchAndValidateProviderMetadata(providerRegistration);
      const previousJwksUri = providerState.metadata?.value.jwksUri.href;
      const metadataGeneration = providerState.metadataGeneration + 1;

      providerState.metadata = refreshed.cacheable ? refreshed : undefined;
      providerState.metadataFailure = undefined;
      providerState.metadataGeneration = metadataGeneration;
      this.#observe({
        event: "oidc_provider_configuration_refreshed",
        ...cacheFreshnessDiagnostics(refreshed),
        issuer: providerRegistration.issuer,
        jwkSetHost: refreshed.value.jwksUri.hostname,
        metadataGeneration,
      });

      if (previousJwksUri !== undefined && previousJwksUri !== refreshed.value.jwksUri.href) {
        providerState.jwks = undefined;
        providerState.jwksFailure = undefined;
        providerState.jwksRefreshAllowedAfter = undefined;
        this.#observe({
          event: "oidc_provider_jwks_uri_changed",
          issuer: providerRegistration.issuer,
          jwkSetHost: refreshed.value.jwksUri.hostname,
          metadataGeneration,
          previousJwkSetHost: new URL(previousJwksUri).hostname,
        });
      }

      return refreshed.value;
    } catch (error) {
      providerState.metadataFailure = {
        error,
        retryAfter: now + providerFailureBackoffMilliseconds,
      };
      this.#observeRefreshFailure(
        providerRegistration.issuer,
        "provider_configuration",
        error,
        providerState.metadata,
        providerState.metadataGeneration,
      );

      throw error;
    } finally {
      providerState.metadataRefresh = undefined;
    }
  }

  async #fetchAndValidateProviderMetadata(
    providerRegistration: OidcProviderRegistration,
  ): Promise<CacheEntry<ValidatedOidcProviderMetadata>> {
    const configurationUrl = deriveOidcProviderConfigurationUrl(providerRegistration.issuer);
    let response: { cacheControl: string | null; document: unknown };

    try {
      response = await fetchAndParseOidcRemoteDocument(
        this.#dependencies.fetch,
        configurationUrl,
        providerConfigurationResponseByteLimit,
        "PROVIDER_CONFIGURATION",
      );
    } catch (error) {
      if (isInvalidProviderConfigurationRepresentation(error)) {
        throw new OidcProviderMetadataValidationError();
      }

      throw error;
    }

    const providerMetadata = parseOidcProviderMetadata(response.document, providerRegistration);

    return cacheEntry(providerMetadata, response.cacheControl, this.#dependencies.now().getTime());
  }

  async #remoteJwks(
    providerMetadata: ValidatedOidcProviderMetadata,
    providerState: ProviderState,
    forceRefresh: boolean,
  ): Promise<CachedJwks> {
    const now = this.#dependencies.now().getTime();
    const current = providerState.jwks;
    const identity = createJwksResolutionIdentity(
      providerMetadata.jwksUri,
      providerMetadata.acceptedIdTokenSigningAlgorithms,
    );

    if (
      !forceRefresh &&
      current !== undefined &&
      jwksResolutionIdentitiesEqual(current.value.identity, identity) &&
      now < current.freshUntil
    ) {
      return current.value;
    }

    if (
      forceRefresh &&
      current !== undefined &&
      jwksResolutionIdentitiesEqual(current.value.identity, identity) &&
      now < (providerState.jwksRefreshAllowedAfter ?? 0)
    ) {
      this.#observe({
        event: "oidc_jwk_set_refresh_suppressed",
        issuer: providerMetadata.issuer,
        jwkSetHost: providerMetadata.jwksUri.hostname,
        metadataGeneration: providerState.metadataGeneration,
      });

      return current.value;
    }

    if (
      providerState.jwksFailure !== undefined &&
      jwksResolutionIdentitiesEqual(providerState.jwksFailure.identity, identity) &&
      now < providerState.jwksFailure.retryAfter
    ) {
      if (
        !forceRefresh &&
        current !== undefined &&
        jwksResolutionIdentitiesEqual(current.value.identity, identity) &&
        now < current.staleUntil
      ) {
        this.#observeStaleOidcRemoteDocument(
          providerMetadata.issuer,
          "jwk_set",
          current,
          providerState.metadataGeneration,
        );

        return current.value;
      }

      throw providerState.jwksFailure.error;
    }

    let refresh = providerState.jwksRefresh;

    if (refresh === undefined || !jwksResolutionIdentitiesEqual(refresh.identity, identity)) {
      refresh = {
        identity,
        result: this.#fetchRemoteJwks(identity, providerMetadata.acceptedIdTokenSigningAlgorithms),
      };
      providerState.jwksRefresh = refresh;
    }

    try {
      const refreshed = await refresh.result;

      if (!jwksResolutionIdentitiesEqual(refreshed.value.identity, refresh.identity)) {
        throw new OidcRemoteDocumentError("ERR_OIDC_JWKS_REFRESH_IDENTITY_MISMATCH");
      }

      if (providerState.jwksRefresh === refresh) {
        providerState.jwks = refreshed.cacheable ? refreshed : undefined;
        providerState.jwksFailure = undefined;
        providerState.jwksRefreshAllowedAfter = refreshed.cacheable
          ? this.#dependencies.now().getTime() + jwksRefreshCooldownMilliseconds
          : undefined;
      }

      return refreshed.value;
    } catch (error) {
      if (providerState.jwksRefresh === refresh) {
        providerState.jwksFailure = {
          error,
          identity,
          retryAfter: now + providerFailureBackoffMilliseconds,
        };
      }
      this.#observeRefreshFailure(
        providerMetadata.issuer,
        "jwk_set",
        error,
        current,
        providerState.metadataGeneration,
      );

      if (
        !forceRefresh &&
        current !== undefined &&
        jwksResolutionIdentitiesEqual(current.value.identity, identity) &&
        now < current.staleUntil
      ) {
        this.#observeStaleOidcRemoteDocument(
          providerMetadata.issuer,
          "jwk_set",
          current,
          providerState.metadataGeneration,
        );

        return current.value;
      }

      throw error;
    } finally {
      if (providerState.jwksRefresh === refresh) {
        providerState.jwksRefresh = undefined;
      }
    }
  }

  async #fetchRemoteJwks(
    identity: JwksResolutionIdentity,
    acceptedIdTokenSigningAlgorithms: readonly OidcIdTokenSigningAlgorithm[],
  ): Promise<CacheEntry<CachedJwks>> {
    const jwksUri = new URL(identity.jwksUri);
    const response = await fetchAndParseOidcRemoteDocument(
      this.#dependencies.fetch,
      jwksUri,
      jwksResponseByteLimit,
      "JWKS",
    );

    if (!isJsonWebKeySet(response.document)) {
      throw new OidcRemoteDocumentError("ERR_OIDC_JWKS_INVALID");
    }

    if (response.document.keys.length > jwksKeyCountLimit) {
      throw new OidcRemoteDocumentError("ERR_OIDC_JWKS_KEY_LIMIT_EXCEEDED");
    }

    const hasUsableVerificationKey = await jsonWebKeySetHasUsableVerificationKey(
      response.document,
      acceptedIdTokenSigningAlgorithms,
    );

    if (!hasUsableVerificationKey) {
      throw new OidcRemoteDocumentError("ERR_OIDC_JWKS_NO_USABLE_VERIFICATION_KEY");
    }

    const localGetKey = createLocalJWKSet(response.document);

    const getKey: JWTVerifyGetKey = async (protectedHeader, token) => {
      try {
        return await localGetKey(protectedHeader, token);
      } catch (error) {
        if (hasJoseErrorCode(error, "ERR_JWKS_NO_MATCHING_KEY")) {
          throw error;
        }

        throw new OidcRemoteDocumentError("ERR_OIDC_JWKS_KEY_INVALID", {
          cause: error,
        });
      }
    };

    return cacheEntry(
      Object.freeze({
        getKey,
        identity,
      }),
      response.cacheControl,
      this.#dependencies.now().getTime(),
    );
  }

  #observe(event: OidcIdTokenAuthenticationEvent): void {
    this.#dependencies.observe?.(event);
  }

  #observeRefreshFailure(
    issuer: OidcIssuerIdentifier,
    remoteDocumentKind: "jwk_set" | "provider_configuration",
    error: unknown,
    current: CacheEntry<unknown> | undefined,
    metadataGeneration: number | undefined,
  ): void {
    const diagnosticCode = diagnosticCodeOf(error);
    const providerHttpStatus = providerHttpStatusOf(error);

    this.#observe({
      remoteDocumentKind,
      ...(current === undefined ? {} : cacheFreshnessDiagnostics(current)),
      ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
      event: "oidc_remote_document_refresh_failed",
      issuer,
      ...(metadataGeneration === undefined || metadataGeneration === 0
        ? {}
        : { metadataGeneration }),
      ...(providerHttpStatus === undefined ? {} : { providerHttpStatus }),
    });
  }

  #observeStaleOidcRemoteDocument(
    issuer: OidcIssuerIdentifier,
    remoteDocumentKind: "jwk_set" | "provider_configuration",
    current: CacheEntry<unknown>,
    metadataGeneration: number | undefined,
  ): void {
    this.#observe({
      ...cacheFreshnessDiagnostics(current),
      remoteDocumentKind,
      event: "oidc_remote_document_stale_used",
      issuer,
      ...(metadataGeneration === undefined ? {} : { metadataGeneration }),
    });
  }
}

export function createOidcIdTokenAuthenticator(
  trust: OidcIdTokenAuthenticationTrust,
  dependencies: OidcIdTokenAuthenticatorDependencies,
): OidcIdTokenAuthenticator {
  return new OidcIdTokenAuthenticatorImplementation(trust, dependencies);
}

async function verifyIdToken(input: {
  acceptedIdTokenSigningAlgorithms: readonly OidcIdTokenSigningAlgorithm[];
  cachedJwks: CachedJwks;
  idToken: string;
  providerRegistration: OidcProviderRegistration;
  subjectTokenAudience: string;
}): Promise<VerifiedOidcIdToken> {
  const { payload, protectedHeader } = await jwtVerify(input.idToken, input.cachedJwks.getKey, {
    algorithms: [...input.acceptedIdTokenSigningAlgorithms],
    audience: input.subjectTokenAudience,
    issuer: input.providerRegistration.issuer,
    requiredClaims: ["aud", "sub", "exp", "iat"],
  });

  const claims = parseVerifiedOidcIdTokenClaims(payload, input.subjectTokenAudience);

  if (claims === null) {
    throw new OidcSubjectTokenError("ERR_JWT_CLAIM_VALIDATION_FAILED");
  }

  return {
    claims,
    issuer: input.providerRegistration.issuer,
    resolvedKeyId: typeof protectedHeader.kid === "string" ? protectedHeader.kid : null,
  };
}

async function fetchAndParseOidcRemoteDocument(
  fetchImplementation: typeof fetch,
  url: URL,
  byteLimit: number,
  documentKind: "JWKS" | "PROVIDER_CONFIGURATION",
): Promise<{ cacheControl: string | null; document: unknown }> {
  let response: Response;
  const requestSignal = AbortSignal.timeout(providerRequestTimeoutMilliseconds);

  try {
    response = await fetchImplementation(url, {
      headers: { accept: "application/json" },
      // Workerd exposes redirects only in manual mode; the exact-200 check below rejects them.
      redirect: "manual",
      signal: requestSignal,
    });
  } catch (error) {
    throw oidcRemoteDocumentTransportError(error, requestSignal, documentKind);
  }

  if (response.status !== 200) {
    throw new OidcRemoteDocumentError(`ERR_OIDC_${documentKind}_HTTP_STATUS`, {
      providerHttpStatus: response.status,
    });
  }

  if (!isExpectedJsonContentType(response.headers.get("content-type"), documentKind)) {
    throw new OidcRemoteDocumentError(`ERR_OIDC_${documentKind}_CONTENT_TYPE_INVALID`);
  }

  const declaredLength = response.headers.get("content-length");

  if (
    declaredLength !== null &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > byteLimit
  ) {
    throw new OidcRemoteDocumentError(`ERR_OIDC_${documentKind}_RESPONSE_LIMIT_EXCEEDED`);
  }

  let bodyResult;

  try {
    bodyResult = await readBodyUpTo(response.body, byteLimit);
  } catch (error) {
    throw oidcRemoteDocumentTransportError(error, requestSignal, documentKind);
  }

  if (!bodyResult.ok) {
    throw new OidcRemoteDocumentError(`ERR_OIDC_${documentKind}_RESPONSE_LIMIT_EXCEEDED`);
  }

  let document: unknown;

  try {
    document = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bodyResult.bytes),
    );
  } catch (error) {
    throw new OidcRemoteDocumentError(`ERR_OIDC_${documentKind}_JSON_PARSE_FAILED`, {
      cause: error,
    });
  }

  return {
    cacheControl: response.headers.get("cache-control"),
    document,
  };
}

function oidcRemoteDocumentTransportError(
  error: unknown,
  requestSignal: AbortSignal,
  documentKind: "JWKS" | "PROVIDER_CONFIGURATION",
): OidcRemoteDocumentError {
  const timedOut =
    hasErrorName(error, "TimeoutError") ||
    (requestSignal.aborted && hasErrorName(requestSignal.reason, "TimeoutError"));

  return new OidcRemoteDocumentError(
    timedOut ? `ERR_OIDC_${documentKind}_TIMEOUT` : `ERR_OIDC_${documentKind}_FETCH_FAILED`,
    { cause: error },
  );
}

function isInvalidProviderConfigurationRepresentation(error: unknown): boolean {
  return (
    error instanceof OidcRemoteDocumentError &&
    (error.code === "ERR_OIDC_PROVIDER_CONFIGURATION_CONTENT_TYPE_INVALID" ||
      error.code === "ERR_OIDC_PROVIDER_CONFIGURATION_JSON_PARSE_FAILED" ||
      error.code === "ERR_OIDC_PROVIDER_CONFIGURATION_RESPONSE_LIMIT_EXCEEDED")
  );
}

class OidcRemoteDocumentError extends Error {
  public readonly code: string;
  public readonly providerHttpStatus: number | undefined;

  public constructor(code: string, options: { cause?: unknown; providerHttpStatus?: number } = {}) {
    super(
      "OIDC remote document unavailable",
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.code = code;
    this.name = "OidcRemoteDocumentError";
    this.providerHttpStatus = options.providerHttpStatus;
  }
}

class OidcSubjectTokenError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super("OIDC subject token rejected");
    this.code = code;
    this.name = "OidcSubjectTokenError";
  }
}

function cacheEntry<Value>(
  value: Value,
  cacheControl: string | null,
  now: number,
): CacheEntry<Value> {
  const cacheable = !hasCacheControlDirective(cacheControl, "no-store");
  const freshnessSeconds = boundedFreshnessSeconds(cacheControl);
  const freshUntil = now + freshnessSeconds * 1000;
  const staleAllowed =
    !hasCacheControlDirective(cacheControl, "must-revalidate") &&
    !hasCacheControlDirective(cacheControl, "no-cache");

  return {
    cacheable,
    freshUntil,
    staleUntil:
      cacheable && staleAllowed ? freshUntil + staleIfProviderUnavailableSeconds * 1000 : now,
    value,
  };
}

function cacheFreshnessDiagnostics(entry: Pick<CacheEntry<unknown>, "freshUntil" | "staleUntil">): {
  freshUntil: string;
  staleUntil: string;
} {
  return {
    freshUntil: new Date(entry.freshUntil).toISOString(),
    staleUntil: new Date(entry.staleUntil).toISOString(),
  };
}

function boundedFreshnessSeconds(cacheControl: string | null): number {
  if (hasCacheControlDirective(cacheControl, "no-cache")) {
    return 0;
  }

  const match = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/iu.exec(cacheControl ?? "");
  const advertisedSeconds = match?.[1] === undefined ? defaultFreshnessSeconds : Number(match[1]);

  return Math.min(advertisedSeconds, maximumFreshnessSeconds);
}

function hasCacheControlDirective(
  cacheControl: string | null,
  directive: "must-revalidate" | "no-cache" | "no-store",
): boolean {
  return (cacheControl ?? "").split(",").some((value) => value.trim().toLowerCase() === directive);
}

function classifyAuthenticationError(error: unknown): OidcIdTokenAuthenticationFailureResult {
  const diagnosticCode = diagnosticCodeOf(error);

  if (error instanceof OidcRemoteDocumentError) {
    return providerUnavailable(diagnosticCode, error.providerHttpStatus);
  }

  if (error instanceof OidcSubjectTokenError) {
    return subjectTokenRejected(diagnosticCode);
  }

  if (error instanceof errors.JOSEError) {
    if (subjectTokenJoseErrorCodes.has(error.code)) {
      return subjectTokenRejected(error.code);
    }

    if (providerJoseErrorCodes.has(error.code)) {
      return providerUnavailable(error.code);
    }

    return internalFailure(error.code);
  }

  if (error instanceof OidcProviderMetadataValidationError) {
    return subjectTokenRejected(diagnosticCode);
  }

  return internalFailure(diagnosticCode);
}

const subjectTokenJoseErrorCodes = new Set([
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_EXPIRED",
  "ERR_JWT_INVALID",
]);

const providerJoseErrorCodes = new Set([
  "ERR_JOSE_NOT_SUPPORTED",
  "ERR_JWK_INVALID",
  "ERR_JWKS_INVALID",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
]);

function subjectTokenRejected(diagnosticCode?: string): OidcIdTokenAuthenticationFailureResult {
  return {
    failure: {
      diagnostics: diagnosticCode === undefined ? {} : { diagnosticCode },
      kind: "subject_token_rejected",
    },
    ok: false,
  };
}

function providerUnavailable(
  diagnosticCode?: string,
  providerHttpStatus?: number,
): OidcIdTokenAuthenticationFailureResult {
  return {
    failure: {
      diagnostics: {
        ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
        ...(providerHttpStatus === undefined ? {} : { providerHttpStatus }),
      },
      kind: "provider_unavailable",
    },
    ok: false,
  };
}

function internalFailure(diagnosticCode?: string): OidcIdTokenAuthenticationFailureResult {
  return {
    failure: {
      diagnostics: diagnosticCode === undefined ? {} : { diagnosticCode },
      kind: "internal_failure",
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

function parseVerifiedOidcIdTokenClaims(
  input: Record<string, unknown>,
  subjectTokenAudience: string,
): VerifiedOidcIdTokenClaims | null {
  const parsed = verifiedOidcIdTokenClaimsSchema.safeParse(input);

  return parsed.success && parsed.data.aud === subjectTokenAudience ? parsed.data : null;
}

function isJsonWebKeySet(input: unknown): input is JSONWebKeySet {
  return (
    typeof input === "object" &&
    input !== null &&
    "keys" in input &&
    Array.isArray(input.keys) &&
    input.keys.every((key) => typeof key === "object" && key !== null && !Array.isArray(key))
  );
}

function createJwksResolutionIdentity(
  jwksUri: URL,
  acceptedIdTokenSigningAlgorithms: readonly OidcIdTokenSigningAlgorithm[],
): JwksResolutionIdentity {
  return Object.freeze({
    acceptedIdTokenSigningAlgorithmsFingerprint: acceptedIdTokenSigningAlgorithms.join(" "),
    jwksUri: jwksUri.href,
  });
}

function jwksResolutionIdentitiesEqual(
  left: JwksResolutionIdentity,
  right: JwksResolutionIdentity,
): boolean {
  return (
    left.jwksUri === right.jwksUri &&
    left.acceptedIdTokenSigningAlgorithmsFingerprint ===
      right.acceptedIdTokenSigningAlgorithmsFingerprint
  );
}

async function jsonWebKeySetHasUsableVerificationKey(
  jwks: JSONWebKeySet,
  acceptedAlgorithms: readonly OidcIdTokenSigningAlgorithm[],
): Promise<boolean> {
  for (const algorithm of acceptedAlgorithms) {
    for (const jwk of jwks.keys) {
      if (!jsonWebKeyCanVerifyAlgorithm(jwk, algorithm)) {
        continue;
      }

      try {
        const key = await importJWK({ ...jwk, ext: true }, algorithm);

        if (!(key instanceof Uint8Array) && key.type === "public") {
          return true;
        }
      } catch {
        // Continue until one member is demonstrably usable for an accepted algorithm.
      }
    }
  }

  return false;
}

function jsonWebKeyCanVerifyAlgorithm(jwk: JWK, algorithm: OidcIdTokenSigningAlgorithm): boolean {
  if (
    (typeof jwk.alg === "string" && jwk.alg !== algorithm) ||
    (typeof jwk.use === "string" && jwk.use !== "sig") ||
    (Array.isArray(jwk.key_ops) && !jwk.key_ops.includes("verify"))
  ) {
    return false;
  }

  const expectedShape = verificationJwkShapeByAlgorithm[algorithm];

  return (
    jwk.kty === expectedShape.kty && (!("crv" in expectedShape) || jwk.crv === expectedShape.crv)
  );
}

function isExpectedJsonContentType(
  contentType: string | null,
  documentKind: "JWKS" | "PROVIDER_CONFIGURATION",
): boolean {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();

  return (
    mediaType === "application/json" ||
    (documentKind === "JWKS" && mediaType === "application/jwk-set+json")
  );
}

function hasJoseErrorCode(error: unknown, code: string): boolean {
  return error instanceof errors.JOSEError && error.code === code;
}

function diagnosticCodeOf(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }

  return undefined;
}

function providerHttpStatusOf(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "providerHttpStatus" in error &&
    typeof error.providerHttpStatus === "number"
  ) {
    return error.providerHttpStatus;
  }

  return undefined;
}

function hasErrorName(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === name;
}
