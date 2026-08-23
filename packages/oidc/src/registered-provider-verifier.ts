import { readBodyUpTo } from "@github-app-token-broker/http/body";
import {
  createLocalJWKSet,
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
  isOidcIdTokenSigningAlgorithm,
  type OidcIssuerIdentifier,
  type OidcIdTokenSigningAlgorithm,
  type OidcProviderRegistration,
} from "./provider-registration.ts";
import type {
  OidcIdTokenAuthenticationEvent,
  OidcIdTokenAuthenticationResult,
} from "./id-token-authenticator.ts";
import type { SubjectTokenAudience } from "./subject-token-audience.ts";
import type {
  ReadonlyJsonValue,
  VerifiedOidcIdToken,
  VerifiedOidcIdTokenClaims,
} from "./verified-id-token.ts";

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

type OidcIdTokenAuthenticationFailureResult = Extract<
  OidcIdTokenAuthenticationResult,
  { readonly ok: false }
>;

interface RegisteredOidcProviderVerifierDependencies {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
}

export interface RegisteredOidcProviderVerifier {
  verifyIdToken(
    idToken: string,
    observe?: (event: OidcIdTokenAuthenticationEvent) => void,
  ): Promise<OidcIdTokenAuthenticationResult>;
}

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
  failureDiagnosticAttempted: boolean;
  readonly failureDiagnosticObserver: ((event: OidcIdTokenAuthenticationEvent) => void) | undefined;
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

class RegisteredOidcProviderVerifierImplementation implements RegisteredOidcProviderVerifier {
  readonly #dependencies: RegisteredOidcProviderVerifierDependencies;
  readonly #providerRegistration: OidcProviderRegistration;
  readonly #state: ProviderState = { metadataGeneration: 0 };
  readonly #subjectTokenAudience: SubjectTokenAudience;

  public constructor(
    providerRegistration: OidcProviderRegistration,
    subjectTokenAudience: SubjectTokenAudience,
    dependencies: RegisteredOidcProviderVerifierDependencies,
  ) {
    this.#dependencies = dependencies;
    this.#providerRegistration = providerRegistration;
    this.#subjectTokenAudience = subjectTokenAudience;
  }

  public async verifyIdToken(
    idToken: string,
    observe?: (event: OidcIdTokenAuthenticationEvent) => void,
  ): Promise<OidcIdTokenAuthenticationResult> {
    try {
      const operationDate = new Date(this.#dependencies.now().getTime());
      const operationTime = operationDate.getTime();
      const providerMetadata = await this.#providerMetadata(operationTime, observe);
      const acceptedIdTokenSigningAlgorithms = providerMetadata.acceptedIdTokenSigningAlgorithms;
      const protectedHeader = decodeProtectedHeader(idToken);

      if (
        typeof protectedHeader.alg !== "string" ||
        !isOidcIdTokenSigningAlgorithm(protectedHeader.alg) ||
        !acceptedIdTokenSigningAlgorithms.includes(protectedHeader.alg)
      ) {
        return subjectTokenRejected("ERR_JOSE_ALG_NOT_ALLOWED");
      }

      let cachedJwks = await this.#remoteJwks(providerMetadata, false, operationTime, observe);
      let verifiedIdToken: VerifiedOidcIdToken;

      try {
        verifiedIdToken = await verifyIdToken({
          acceptedIdTokenSigningAlgorithms,
          cachedJwks,
          providerRegistration: this.#providerRegistration,
          idToken,
          operationDate,
          subjectTokenAudience: this.#subjectTokenAudience,
        });
      } catch (error) {
        if (!hasJoseErrorCode(error, "ERR_JWKS_NO_MATCHING_KEY")) {
          throw error;
        }

        try {
          cachedJwks = await this.#remoteJwks(providerMetadata, true, operationTime, observe);
        } catch (refreshError) {
          if (this.#isFreshCachedJwks(providerMetadata, cachedJwks, operationTime)) {
            throw error;
          }

          throw refreshError;
        }

        verifiedIdToken = await verifyIdToken({
          acceptedIdTokenSigningAlgorithms,
          cachedJwks,
          providerRegistration: this.#providerRegistration,
          idToken,
          operationDate,
          subjectTokenAudience: this.#subjectTokenAudience,
        });
      }

      if (
        this.#providerRegistration.idTokenProfile !== null &&
        !this.#providerRegistration.idTokenProfile.validate(verifiedIdToken.claims)
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
    now: number,
    observe: ((event: OidcIdTokenAuthenticationEvent) => void) | undefined,
  ): Promise<ValidatedOidcProviderMetadata> {
    if (this.#state.metadata !== undefined && now < this.#state.metadata.freshUntil) {
      return this.#state.metadata.value;
    }

    if (this.#state.metadataFailure !== undefined && now < this.#state.metadataFailure.retryAfter) {
      if (
        this.#state.metadataFailure.error instanceof OidcRemoteDocumentError &&
        this.#state.metadata !== undefined &&
        now < this.#state.metadata.staleUntil
      ) {
        this.#observeStaleOidcRemoteDocument(
          this.#providerRegistration.issuer,
          "provider_configuration",
          this.#state.metadata,
          this.#state.metadataGeneration,
          observe,
        );

        return this.#state.metadata.value;
      }

      throw this.#state.metadataFailure.error;
    }

    if (this.#state.metadataRefresh === undefined) {
      this.#state.metadataRefresh = this.#refreshAndPublishProviderMetadata(now, observe);
    }

    try {
      return await this.#state.metadataRefresh;
    } catch (error) {
      if (
        error instanceof OidcRemoteDocumentError &&
        this.#state.metadata !== undefined &&
        now < this.#state.metadata.staleUntil
      ) {
        this.#observeStaleOidcRemoteDocument(
          this.#providerRegistration.issuer,
          "provider_configuration",
          this.#state.metadata,
          this.#state.metadataGeneration,
          observe,
        );

        return this.#state.metadata.value;
      }

      throw error;
    }
  }

  async #refreshAndPublishProviderMetadata(
    now: number,
    observe: ((event: OidcIdTokenAuthenticationEvent) => void) | undefined,
  ): Promise<ValidatedOidcProviderMetadata> {
    try {
      const refreshed = await this.#fetchAndValidateProviderMetadata(now);
      const previousJwksUri = this.#state.metadata?.value.jwksUri.href;
      const metadataGeneration = this.#state.metadataGeneration + 1;

      this.#state.metadata = refreshed.cacheable ? refreshed : undefined;
      this.#state.metadataFailure = undefined;
      this.#state.metadataGeneration = metadataGeneration;
      this.#observe(
        {
          event: "oidc_provider_configuration_refreshed",
          ...cacheFreshnessDiagnostics(refreshed),
          issuer: this.#providerRegistration.issuer,
          jwkSetHost: refreshed.value.jwksUri.hostname,
          metadataGeneration,
        },
        observe,
      );

      if (previousJwksUri !== undefined && previousJwksUri !== refreshed.value.jwksUri.href) {
        this.#state.jwks = undefined;
        this.#state.jwksFailure = undefined;
        this.#state.jwksRefreshAllowedAfter = undefined;
        this.#observe(
          {
            event: "oidc_provider_jwks_uri_changed",
            issuer: this.#providerRegistration.issuer,
            jwkSetHost: refreshed.value.jwksUri.hostname,
            metadataGeneration,
            previousJwkSetHost: new URL(previousJwksUri).hostname,
          },
          observe,
        );
      }

      return refreshed.value;
    } catch (error) {
      this.#state.metadataFailure = {
        error,
        retryAfter: now + providerFailureBackoffMilliseconds,
      };
      this.#observeRefreshFailure(
        this.#providerRegistration.issuer,
        "provider_configuration",
        error,
        this.#state.metadata,
        this.#state.metadataGeneration,
        observe,
      );

      throw error;
    } finally {
      this.#state.metadataRefresh = undefined;
    }
  }

  async #fetchAndValidateProviderMetadata(
    now: number,
  ): Promise<CacheEntry<ValidatedOidcProviderMetadata>> {
    const configurationUrl = deriveOidcProviderConfigurationUrl(this.#providerRegistration.issuer);
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

    const providerMetadata = parseOidcProviderMetadata(
      response.document,
      this.#providerRegistration,
    );

    return cacheEntry(providerMetadata, response.cacheControl, now);
  }

  async #remoteJwks(
    providerMetadata: ValidatedOidcProviderMetadata,
    forceRefresh: boolean,
    now: number,
    observe: ((event: OidcIdTokenAuthenticationEvent) => void) | undefined,
  ): Promise<CachedJwks> {
    const current = this.#state.jwks;
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
      now < current.freshUntil &&
      now < (this.#state.jwksRefreshAllowedAfter ?? 0)
    ) {
      this.#observe(
        {
          event: "oidc_jwk_set_refresh_suppressed",
          issuer: providerMetadata.issuer,
          jwkSetHost: providerMetadata.jwksUri.hostname,
          metadataGeneration: this.#state.metadataGeneration,
        },
        observe,
      );

      return current.value;
    }

    if (
      this.#state.jwksFailure !== undefined &&
      jwksResolutionIdentitiesEqual(this.#state.jwksFailure.identity, identity) &&
      now < this.#state.jwksFailure.retryAfter
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
          this.#state.metadataGeneration,
          observe,
        );

        return current.value;
      }

      throw this.#state.jwksFailure.error;
    }

    let refresh = this.#state.jwksRefresh;

    if (refresh === undefined || !jwksResolutionIdentitiesEqual(refresh.identity, identity)) {
      refresh = {
        failureDiagnosticAttempted: false,
        failureDiagnosticObserver: observe,
        identity,
        result: this.#fetchRemoteJwks(
          identity,
          providerMetadata.acceptedIdTokenSigningAlgorithms,
          now,
        ),
      };
      this.#state.jwksRefresh = refresh;
    }

    try {
      const refreshed = await refresh.result;

      if (this.#state.jwksRefresh === refresh) {
        this.#state.jwks = refreshed.cacheable ? refreshed : undefined;
        this.#state.jwksFailure = undefined;
        this.#state.jwksRefreshAllowedAfter = refreshed.cacheable
          ? now + jwksRefreshCooldownMilliseconds
          : undefined;
      }

      return refreshed.value;
    } catch (error) {
      if (this.#state.jwksRefresh === refresh) {
        this.#state.jwksFailure = {
          error,
          identity,
          retryAfter: now + providerFailureBackoffMilliseconds,
        };
      }

      if (!refresh.failureDiagnosticAttempted) {
        refresh.failureDiagnosticAttempted = true;
        this.#observeRefreshFailure(
          providerMetadata.issuer,
          "jwk_set",
          error,
          current,
          this.#state.metadataGeneration,
          refresh.failureDiagnosticObserver,
        );
      }

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
          this.#state.metadataGeneration,
          observe,
        );

        return current.value;
      }

      throw error;
    } finally {
      if (this.#state.jwksRefresh === refresh) {
        this.#state.jwksRefresh = undefined;
      }
    }
  }

  async #fetchRemoteJwks(
    identity: JwksResolutionIdentity,
    acceptedIdTokenSigningAlgorithms: readonly OidcIdTokenSigningAlgorithm[],
    now: number,
  ): Promise<CacheEntry<CachedJwks>> {
    const jwksUri = new URL(identity.jwksUri);
    const response = await fetchAndParseOidcRemoteDocument(
      this.#dependencies.fetch,
      jwksUri,
      jwksResponseByteLimit,
      "JWKS",
    );

    if (!isJsonWebKeySetContainer(response.document)) {
      throw new OidcRemoteDocumentError("ERR_OIDC_JWKS_INVALID");
    }

    if (response.document.keys.length > jwksKeyCountLimit) {
      throw new OidcRemoteDocumentError("ERR_OIDC_JWKS_KEY_LIMIT_EXCEEDED");
    }

    if (!response.document.keys.every(isStructurallyValidJsonWebKey)) {
      throw new OidcRemoteDocumentError("ERR_OIDC_JWKS_INVALID");
    }

    const jwks: JSONWebKeySet = { keys: response.document.keys };

    const hasUsableVerificationKey = await jsonWebKeySetHasUsableVerificationKey(
      jwks,
      acceptedIdTokenSigningAlgorithms,
    );

    if (!hasUsableVerificationKey) {
      throw new OidcRemoteDocumentError("ERR_OIDC_JWKS_NO_USABLE_VERIFICATION_KEY");
    }

    const localGetKey = createLocalJWKSet(jwks);

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
      now,
    );
  }

  #isFreshCachedJwks(
    providerMetadata: ValidatedOidcProviderMetadata,
    cachedJwks: CachedJwks,
    now: number,
  ): boolean {
    const current = this.#state.jwks;

    return (
      current !== undefined &&
      current.value === cachedJwks &&
      jwksResolutionIdentitiesEqual(
        current.value.identity,
        createJwksResolutionIdentity(
          providerMetadata.jwksUri,
          providerMetadata.acceptedIdTokenSigningAlgorithms,
        ),
      ) &&
      now < current.freshUntil
    );
  }

  #observe(
    event: OidcIdTokenAuthenticationEvent,
    observe: ((event: OidcIdTokenAuthenticationEvent) => void) | undefined,
  ): void {
    try {
      observe?.(event);
    } catch {
      // Optional OIDC diagnostics cannot change authentication or token issuance.
    }
  }

  #observeRefreshFailure(
    issuer: OidcIssuerIdentifier,
    remoteDocumentKind: "jwk_set" | "provider_configuration",
    error: unknown,
    current: CacheEntry<unknown> | undefined,
    metadataGeneration: number | undefined,
    observe: ((event: OidcIdTokenAuthenticationEvent) => void) | undefined,
  ): void {
    const diagnosticCode = diagnosticCodeOf(error);
    const providerHttpStatus = providerHttpStatusOf(error);

    this.#observe(
      {
        remoteDocumentKind,
        ...(current === undefined ? {} : cacheFreshnessDiagnostics(current)),
        ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
        event: "oidc_remote_document_refresh_failed",
        issuer,
        ...(metadataGeneration === undefined || metadataGeneration === 0
          ? {}
          : { metadataGeneration }),
        ...(providerHttpStatus === undefined ? {} : { providerHttpStatus }),
      },
      observe,
    );
  }

  #observeStaleOidcRemoteDocument(
    issuer: OidcIssuerIdentifier,
    remoteDocumentKind: "jwk_set" | "provider_configuration",
    current: CacheEntry<unknown>,
    metadataGeneration: number,
    observe: ((event: OidcIdTokenAuthenticationEvent) => void) | undefined,
  ): void {
    this.#observe(
      {
        ...cacheFreshnessDiagnostics(current),
        remoteDocumentKind,
        event: "oidc_remote_document_stale_used",
        issuer,
        metadataGeneration,
      },
      observe,
    );
  }
}

export function createRegisteredOidcProviderVerifier(input: {
  readonly dependencies: RegisteredOidcProviderVerifierDependencies;
  readonly providerRegistration: OidcProviderRegistration;
  readonly subjectTokenAudience: SubjectTokenAudience;
}): RegisteredOidcProviderVerifier {
  return new RegisteredOidcProviderVerifierImplementation(
    input.providerRegistration,
    input.subjectTokenAudience,
    input.dependencies,
  );
}

async function verifyIdToken(input: {
  acceptedIdTokenSigningAlgorithms: readonly OidcIdTokenSigningAlgorithm[];
  cachedJwks: CachedJwks;
  idToken: string;
  operationDate: Date;
  providerRegistration: OidcProviderRegistration;
  subjectTokenAudience: SubjectTokenAudience;
}): Promise<VerifiedOidcIdToken> {
  const { payload, protectedHeader } = await jwtVerify(input.idToken, input.cachedJwks.getKey, {
    algorithms: [...input.acceptedIdTokenSigningAlgorithms],
    audience: input.subjectTokenAudience,
    issuer: input.providerRegistration.issuer,
    currentDate: input.operationDate,
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
    bodyResult = await readBodyUpTo(response.body, byteLimit, requestSignal);
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
    return providerUnavailable(error.code, error.providerHttpStatus);
  }

  if (error instanceof OidcSubjectTokenError) {
    return subjectTokenRejected(error.code);
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
    return subjectTokenRejected(error.code);
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

function subjectTokenRejected(diagnosticCode: string): OidcIdTokenAuthenticationFailureResult {
  return {
    failure: {
      diagnostics: { diagnosticCode },
      kind: "subject_token_rejected",
    },
    ok: false,
  };
}

function providerUnavailable(
  diagnosticCode: string,
  providerHttpStatus?: number,
): OidcIdTokenAuthenticationFailureResult {
  return {
    failure: {
      diagnostics: {
        diagnosticCode,
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

function parseVerifiedOidcIdTokenClaims(
  input: Record<string, unknown>,
  subjectTokenAudience: SubjectTokenAudience,
): VerifiedOidcIdTokenClaims | null {
  const parsed = verifiedOidcIdTokenClaimsSchema.safeParse(input);

  if (!parsed.success || parsed.data.aud !== subjectTokenAudience) {
    return null;
  }

  return recursivelyFreezeJsonValue(
    structuredClone(parsed.data) as ReadonlyJsonValue,
  ) as VerifiedOidcIdTokenClaims;
}

function recursivelyFreezeJsonValue(value: ReadonlyJsonValue): ReadonlyJsonValue {
  if (Array.isArray(value)) {
    for (const member of value) {
      recursivelyFreezeJsonValue(member);
    }

    return Object.freeze(value);
  }

  if (typeof value === "object" && value !== null) {
    for (const member of Object.values(value)) {
      if (member !== undefined) {
        recursivelyFreezeJsonValue(member);
      }
    }

    return Object.freeze(value);
  }

  return value;
}

function isJsonWebKeySetContainer(input: unknown): input is { readonly keys: unknown[] } {
  return (
    typeof input === "object" && input !== null && "keys" in input && Array.isArray(input.keys)
  );
}

function isStructurallyValidJsonWebKey(input: unknown): input is JWK {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }

  const jwk = input as Record<string, unknown>;

  return (
    typeof jwk["kty"] === "string" &&
    optionalMemberIsString(jwk, "alg") &&
    optionalMemberIsString(jwk, "kid") &&
    optionalMemberIsString(jwk, "use") &&
    optionalMemberIsStringArray(jwk, "key_ops") &&
    optionalMemberIsStringArray(jwk, "x5c")
  );
}

function optionalMemberIsString(input: Record<string, unknown>, member: string): boolean {
  return !(member in input) || typeof input[member] === "string";
}

function optionalMemberIsStringArray(input: Record<string, unknown>, member: string): boolean {
  if (!(member in input)) {
    return true;
  }

  const value = input[member];

  return Array.isArray(value) && value.every((item) => typeof item === "string");
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
