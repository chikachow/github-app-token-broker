import type {
  OidcIdTokenAuthenticationFailure,
  OidcIdTokenAuthenticator,
  OidcVerificationEvidence,
  VerifiedSubjectToken,
} from "@github-app-token-broker/oidc/id-token-authenticator";
import type { ObserveOidcDiagnostic, ObserveTokenExchange } from "./events.ts";

export interface AuthenticatedContext {
  readonly verificationEvidence: OidcVerificationEvidence;
  readonly verifiedSubjectToken: VerifiedSubjectToken;
}

export type OidcAuthenticationFailureReason =
  | "invalid_token"
  | "oidc_internal_failure"
  | "oidc_provider_failure";

interface AuthenticateRequestFailure {
  ok: false;
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
  observe: ObserveTokenExchange,
  observeOidcDiagnostic?: ObserveOidcDiagnostic,
): Promise<AuthenticateRequestResult> {
  const authentication = await authenticator.authenticateIdToken(subjectToken, (event) => {
    try {
      observeOidcDiagnostic?.({ fields: event, level: "warn" });
    } catch {
      // Optional OIDC diagnostics must not affect authentication or token issuance.
    }
  });

  if (!authentication.ok) {
    const { failure } = authentication;
    const reason = authenticationFailureReason(failure);
    const { diagnosticCode } = failure.diagnostics;
    const providerHttpStatus =
      failure.kind === "provider_unavailable" ? failure.diagnostics.providerHttpStatus : undefined;

    await observe({
      fields: {
        ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
        ...(providerHttpStatus === undefined ? {} : { providerHttpStatus }),
        path: new URL(request.url).pathname,
        reason,
        userAgent: request.headers.get("user-agent"),
      },
      level: "warn",
      message: "OIDC authentication failed",
    });

    return {
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
