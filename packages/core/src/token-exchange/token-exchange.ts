import { jsonResponse } from "../http/problem-details.ts";
import { readRequestBodyUpTo } from "../http/request-body.ts";
import { normalizeInstallationAccessTokenRequest } from "../github/installation-access-token-request.ts";
import type {
  InstallationAccessTokenExchange,
  InstallationAccessTokenExchangeFailureReason,
} from "./installation-access-token-exchange.ts";
import type { TokenExchangeRequestContext } from "./events.ts";
import {
  createTokenExchangeLifetime,
  assertTokenExchangeActive,
  observeWithinTokenExchangeLifetime,
  TokenExchangeUnavailableError,
} from "./lifetime.ts";

/** @public */
export const maxTokenExchangeBodyBytes = 64 * 1024;
const tokenExchangeGrantType = "urn:ietf:params:oauth:grant-type:token-exchange";
const accessTokenType = "urn:ietf:params:oauth:token-type:access_token";
const legacyGithubInstallationAccessTokenType =
  "urn:chikachow:github-app-installation-access-token";
const oidcIdTokenType = "urn:ietf:params:oauth:token-type:id_token";
const unsupportedInvalidTargetParameters = ["audience"];
const unsupportedInvalidRequestParameters = [
  "actor_token",
  "actor_token_type",
  "authorization_details",
  "client_assertion",
  "client_assertion_type",
  "client_id",
  "client_secret",
];
const oauthFailureByReason = {
  internal_failure: { error: "server_error", status: 500 },
  invalid_token: { error: "invalid_request", status: 400 },
  oidc_internal_failure: { error: "server_error", status: 500 },
  oidc_provider_failure: { error: "temporarily_unavailable", status: 503 },
  requested_permissions_unsupported: { error: "invalid_scope", status: 400 },
  subject_token_unacceptable: { error: "invalid_request", status: 400 },
  target_unsupported: { error: "invalid_target", status: 400 },
  upstream_failure: { error: "server_error", status: 502 },
  upstream_unavailable: { error: "temporarily_unavailable", status: 503 },
} as const satisfies Readonly<
  Record<InstallationAccessTokenExchangeFailureReason, { error: string; status: number }>
>;

/** @public */
export function tokenExchangeInvalidRequestResponse(status: 400 | 413): Response {
  return oauthErrorResponse(status, "invalid_request");
}

interface TokenExchangeEndpointRuntime {
  readonly installationAccessTokenExchange: InstallationAccessTokenExchange;
  now(): Date;
}

export function createTokenExchangeEndpoint(
  runtime: TokenExchangeEndpointRuntime,
): (request: Request, context: TokenExchangeRequestContext) => Promise<Response> {
  return async (request, context) => {
    const lifetime = createTokenExchangeLifetime(request.signal);
    try {
      return await handleTokenExchangeRequestCore(
        new Request(request, { signal: lifetime.signal }),
        runtime,
        {
          ...context,
          observe: observeWithinTokenExchangeLifetime(context.observe, lifetime.signal),
        },
      );
    } catch (error) {
      return unexpectedTokenExchangeFailureResponse(error);
    } finally {
      lifetime.dispose();
    }
  };
}

/** @public */
export function unexpectedTokenExchangeFailureResponse(error: unknown): Response {
  if (error instanceof TokenExchangeUnavailableError) {
    return tokenExchangeUnavailableResponse();
  }
  try {
    console.error({
      error: { name: error instanceof Error ? "Error" : typeof error },
      event: "token_exchange_request_failed",
    });
  } catch {
    // Logging must not prevent the Token Endpoint from returning a sanitized response.
  }

  return oauthErrorResponse(500, "server_error");
}

/** @public */
export function tokenExchangeUnavailableResponse(): Response {
  return oauthErrorResponse(503, "temporarily_unavailable");
}

async function handleTokenExchangeRequestCore(
  request: Request,
  runtime: TokenExchangeEndpointRuntime,
  context: TokenExchangeRequestContext,
): Promise<Response> {
  if (request.method !== "POST") {
    return tokenExchangeInvalidRequestResponse(400);
  }

  if (request.headers.has("authorization")) {
    return oauthErrorResponse(401, "invalid_client", {
      "www-authenticate": wwwAuthenticateChallenge(request.headers.get("authorization")),
    });
  }

  if (!isFormUrlEncodedContentType(request.headers.get("content-type"))) {
    return oauthErrorResponse(400, "invalid_request");
  }

  const body = await readRequestBodyUpTo(request, maxTokenExchangeBodyBytes);

  if (!body.ok) {
    return tokenExchangeInvalidRequestResponse(body.status);
  }

  const form = new URLSearchParams(new TextDecoder().decode(body.bytes));
  const grantType = singleFormValue(form, "grant_type");
  const requestedTokenType = singleFormValue(form, "requested_token_type");
  const subjectToken = singleFormValue(form, "subject_token");
  const subjectTokenType = singleFormValue(form, "subject_token_type");
  const tokenRequestOptions = parseInstallationAccessTokenRequestOptions(form);

  if (grantType === null) {
    return oauthErrorResponse(400, "invalid_request");
  }

  if (grantType !== tokenExchangeGrantType) {
    return oauthErrorResponse(400, "unsupported_grant_type");
  }

  if (subjectToken === null || subjectToken.length === 0 || subjectTokenType === null) {
    return oauthErrorResponse(400, "invalid_request");
  }

  if (subjectTokenType !== oidcIdTokenType) {
    return oauthErrorResponse(400, "invalid_request");
  }

  if (
    requestedTokenType !== accessTokenType &&
    requestedTokenType !== legacyGithubInstallationAccessTokenType
  ) {
    return oauthErrorResponse(400, "invalid_request");
  }

  if (!tokenRequestOptions.ok) {
    return oauthErrorResponse(400, tokenRequestOptions.error);
  }

  const tokenRequest = normalizeInstallationAccessTokenRequest(tokenRequestOptions.options);

  if (!tokenRequest.ok) {
    return oauthErrorResponse(400, tokenRequest.error);
  }

  const result = await runtime.installationAccessTokenExchange(
    {
      request,
      subjectToken,
      tokenRequest: tokenRequest.tokenRequest,
    },
    context,
  );

  if (!result.ok) {
    const failure = oauthFailureByReason[result.reason];

    return oauthErrorResponse(failure.status, failure.error);
  }

  let stage: "lifetime" | "expiry" | "response" = "lifetime";
  try {
    assertTokenExchangeActive(request.signal);
    stage = "expiry";
    const expiresInSeconds = Math.floor(
      (Date.parse(result.expiresAt) - runtime.now().getTime()) / 1000,
    );
    if (!(expiresInSeconds >= 1)) {
      throw new InvalidIssuedTokenExpiryError();
    }
    stage = "lifetime";
    assertTokenExchangeActive(request.signal);
    stage = "response";
    // Response construction commits release synchronously; no asynchronous work follows it.
    return oauthTokenResponse({
      access_token: result.token,
      expires_in: expiresInSeconds,
      issued_token_type: requestedTokenType,
      scope: tokenRequest.tokenRequest.scope,
      token_type: "Bearer",
    });
  } catch (error) {
    await result.discard(stage);
    if (error instanceof InvalidIssuedTokenExpiryError)
      return oauthErrorResponse(502, "server_error");
    throw error;
  }
}

class InvalidIssuedTokenExpiryError extends Error {}

function isFormUrlEncodedContentType(contentType: string | null): boolean {
  if (contentType === null) {
    return false;
  }

  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/x-www-form-urlencoded";
}

function singleFormValue(form: URLSearchParams, key: string): string | null {
  const values = nonEmptyFormValues(form, key);

  if (values.length !== 1) {
    return null;
  }

  return values[0] ?? null;
}

function optionalSingleFormValue(
  form: URLSearchParams,
  key: string,
): { ok: true; value: string | null } | { ok: false } {
  const values = nonEmptyFormValues(form, key);

  if (values.length === 0) {
    return { ok: true, value: null };
  }

  if (values.length !== 1) {
    return { ok: false };
  }

  return { ok: true, value: values[0] ?? null };
}

function hasNonEmptyFormValue(form: URLSearchParams, key: string): boolean {
  return nonEmptyFormValues(form, key).length > 0;
}

function nonEmptyFormValues(form: URLSearchParams, key: string): string[] {
  return form.getAll(key).filter((value) => value.length > 0);
}

function wwwAuthenticateChallenge(authorization: string | null): string {
  const scheme = authorization?.split(/\s+/u, 1)[0];

  if (scheme !== undefined && /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u.test(scheme)) {
    return `${scheme} realm="github-app-token-broker"`;
  }

  return 'Basic realm="github-app-token-broker"';
}

function optionalTokenRequestFormValue(
  form: URLSearchParams,
  key: string,
  blankError: string,
): { ok: true; value: string | null } | { error: string; ok: false } {
  const parsed = optionalSingleFormValue(form, key);

  if (!parsed.ok) {
    return { error: "invalid_request", ok: false };
  }

  if (parsed.value === null) {
    return { ok: true, value: null };
  }

  if (parsed.value.trim().length === 0) {
    return { error: blankError, ok: false };
  }

  return { ok: true, value: parsed.value };
}

function requiredResourceFormValue(
  form: URLSearchParams,
): { ok: true; value: string } | { error: "invalid_target"; ok: false } {
  const value = singleFormValue(form, "resource");

  if (value === null || value.trim().length === 0) {
    return { error: "invalid_target", ok: false };
  }

  return { ok: true, value };
}

function parseInstallationAccessTokenRequestOptions(form: URLSearchParams):
  | {
      ok: true;
      options: {
        resource: string;
        scope: string | null;
      };
    }
  | { error: string; ok: false } {
  if (
    unsupportedInvalidRequestParameters.some((parameter) => hasNonEmptyFormValue(form, parameter))
  ) {
    return { error: "invalid_request", ok: false };
  }

  if (
    unsupportedInvalidTargetParameters.some((parameter) => hasNonEmptyFormValue(form, parameter))
  ) {
    return { error: "invalid_target", ok: false };
  }

  const scope = optionalTokenRequestFormValue(form, "scope", "invalid_scope");
  const resource = requiredResourceFormValue(form);

  if (!scope.ok) {
    return { error: scope.error, ok: false };
  }

  if (!resource.ok) {
    return { error: resource.error, ok: false };
  }

  return {
    ok: true,
    options: {
      resource: resource.value,
      scope: scope.value,
    },
  };
}

function oauthTokenResponse(body: Record<string, number | string>): Response {
  return jsonResponse(body, {
    headers: {
      "cache-control": "no-store",
      pragma: "no-cache",
    },
    status: 200,
  });
}

function oauthErrorResponse(status: number, error: string, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("pragma", "no-cache");

  return jsonResponse(
    { error },
    {
      headers: responseHeaders,
      status,
    },
  );
}
