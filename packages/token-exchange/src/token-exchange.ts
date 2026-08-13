import { jsonResponse } from "@github-app-token-broker/http/problem-details";
import { readRequestBodyUpTo } from "@github-app-token-broker/http/request-body";
import { normalizeInstallationAccessTokenRequest } from "@github-app-token-broker/github/installation-access-token-request";
import type { InstallationAccessTokenExchangeResult } from "./installation-access-token-exchange.ts";
import type { InstallationAccessTokenRequest } from "@github-app-token-broker/github/installation-access-token-request";
import type { InstallationAccessTokenIssuanceFailureReason } from "./installation-access-token-issuance.ts";
import type { TokenExchangeRequestContext } from "./events.ts";

const maxTokenExchangeBodyBytes = 64 * 1024;
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

function tokenExchangeMethodNotAllowedResponse(): Response {
  return oauthErrorResponse(400, "invalid_request");
}

export interface TokenExchangeEndpointRuntime {
  exchange(input: {
    readonly request: Request;
    readonly subjectToken: string;
    readonly tokenRequest: InstallationAccessTokenRequest;
    readonly observe: TokenExchangeRequestContext["observe"];
  }): Promise<InstallationAccessTokenExchangeResult>;
  now(): Date;
}

export async function handleTokenExchangeRequest(
  request: Request,
  context: TokenExchangeRequestContext,
  runtime: TokenExchangeEndpointRuntime,
): Promise<Response> {
  if (request.method !== "POST") {
    return tokenExchangeMethodNotAllowedResponse();
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
    return oauthErrorResponse(body.status, "invalid_request");
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

  const result = await runtime.exchange({
    observe: context.observe,
    request,
    subjectToken,
    tokenRequest: tokenRequest.tokenRequest,
  });

  if (!result.ok) {
    const failure = oauthErrorForTokenExchangeFailure(result);

    return oauthErrorResponse(failure.status, failure.error);
  }

  return oauthTokenResponse({
    access_token: result.token,
    expires_in: expiresInSeconds(result.expiresAt, runtime.now()),
    issued_token_type: requestedTokenType,
    scope: tokenRequest.tokenRequest.scope,
    token_type: "Bearer",
  });
}

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

  if (scheme !== undefined && /^[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*$/u.test(scheme)) {
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

export function oauthErrorResponse(status: number, error: string, headers?: HeadersInit): Response {
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

function oauthErrorForTokenExchangeFailure(
  failure: Extract<InstallationAccessTokenExchangeResult, { ok: false }>,
): { error: string; status: number } {
  if (failure.stage !== "authentication") {
    return oauthErrorForIssuanceFailure(failure.reason);
  }

  const { reason } = failure;

  switch (reason) {
    case "invalid_token":
      return { error: "invalid_request", status: 400 };
    case "oidc_internal_failure":
      return { error: "server_error", status: 500 };
    case "oidc_provider_failure":
      return { error: "temporarily_unavailable", status: 503 };
  }
}

function oauthErrorForIssuanceFailure(reason: InstallationAccessTokenIssuanceFailureReason): {
  error: string;
  status: number;
} {
  switch (reason) {
    case "internal_failure":
      return { error: "server_error", status: 500 };
    case "requested_permissions_unsupported":
      return { error: "invalid_scope", status: 400 };
    case "subject_token_unacceptable":
      return { error: "invalid_request", status: 400 };
    case "target_unsupported":
      return { error: "invalid_target", status: 400 };
    case "upstream_failure":
      return { error: "server_error", status: 502 };
    case "upstream_unavailable":
      return { error: "temporarily_unavailable", status: 503 };
  }
}

function expiresInSeconds(expiresAt: string, now: Date): number {
  const expiresAtMs = Date.parse(expiresAt);

  if (Number.isNaN(expiresAtMs)) {
    return 0;
  }

  return Math.max(0, Math.floor((expiresAtMs - now.getTime()) / 1000));
}
