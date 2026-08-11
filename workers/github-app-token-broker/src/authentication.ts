import type {
  OidcIdTokenAuthenticationFailure,
  OidcIdTokenAuthenticator,
  OidcVerificationEvidence,
  VerifiedSubjectToken,
} from "@github-app-token-broker/oidc/id-token-authenticator";

export type { VerifiedSubjectToken } from "@github-app-token-broker/oidc/id-token-authenticator";

export interface AuthenticatedContext {
  readonly verificationEvidence: OidcVerificationEvidence;
  readonly verifiedSubjectToken: VerifiedSubjectToken;
}

export type OidcAuthenticationFailureReason =
  | "invalid_token"
  | "oidc_internal_failure"
  | "oidc_provider_failure";

interface AuthenticateRequestFailure {
  diagnosticCode?: string;
  ok: false;
  providerHttpStatus?: number;
  reason: OidcAuthenticationFailureReason;
}

interface AuthenticateRequestSuccess {
  context: AuthenticatedContext;
  ok: true;
}

export type AuthenticateRequestResult = AuthenticateRequestFailure | AuthenticateRequestSuccess;

export async function authenticateOidcIdToken(
  subjectToken: string,
  request: Request,
  authenticator: OidcIdTokenAuthenticator,
): Promise<AuthenticateRequestResult> {
  const authentication = await authenticator.authenticateIdToken(subjectToken);

  if (!authentication.ok) {
    const { failure } = authentication;
    const reason = authenticationFailureReason(failure);
    const diagnostics = authenticationFailureDiagnostics(failure);

    logAuthenticationFailure(request, reason, diagnostics);

    return {
      ...diagnostics,
      ok: false,
      reason,
    };
  }

  return {
    context: {
      verificationEvidence: authentication.verificationEvidence,
      verifiedSubjectToken: authentication.verifiedSubjectToken,
    },
    ok: true,
  };
}

function logAuthenticationFailure(
  request: Request,
  reason: OidcAuthenticationFailureReason,
  diagnostics: Pick<AuthenticateRequestFailure, "diagnosticCode" | "providerHttpStatus">,
): void {
  const url = new URL(request.url);

  console.warn("OIDC authentication failed", {
    ...diagnostics,
    path: url.pathname,
    rayId: request.headers.get("cf-ray"),
    reason,
    userAgent: request.headers.get("user-agent"),
  });
}

function authenticationFailureDiagnostics(
  failure: OidcIdTokenAuthenticationFailure,
): Pick<AuthenticateRequestFailure, "diagnosticCode" | "providerHttpStatus"> {
  const { diagnosticCode } = failure.diagnostics;
  const providerHttpStatus =
    failure.kind === "provider_unavailable" ? failure.diagnostics.providerHttpStatus : undefined;

  return {
    ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
    ...(providerHttpStatus === undefined ? {} : { providerHttpStatus }),
  };
}

function authenticationFailureReason(
  failure: OidcIdTokenAuthenticationFailure,
): OidcAuthenticationFailureReason {
  if (failure.kind === "provider_unavailable") {
    return "oidc_provider_failure";
  }

  if (failure.kind === "internal_failure") {
    return "oidc_internal_failure";
  }

  return "invalid_token";
}
