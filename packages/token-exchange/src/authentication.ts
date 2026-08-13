import type {
  OidcIdTokenAuthenticationFailure,
  OidcIdTokenAuthenticator,
  OidcVerificationEvidence,
  VerifiedSubjectToken,
} from "@github-app-token-broker/oidc/id-token-authenticator";
import type { TokenExchangeApplicationContext } from "./events.ts";

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

type AuthenticateRequestResult = AuthenticateRequestFailure | AuthenticateRequestSuccess;

export type AuthenticateSubjectToken = (
  subjectToken: string,
  context: TokenExchangeApplicationContext,
) => Promise<AuthenticateRequestResult>;

export function createAuthenticateSubjectToken(
  authenticator: OidcIdTokenAuthenticator,
): AuthenticateSubjectToken {
  return async (subjectToken, context) => {
    const authentication = await authenticator.authenticateIdToken(subjectToken, (event) =>
      context.observe({ ...event, level: "warn" }),
    );

    if (!authentication.ok) {
      const { failure } = authentication;
      const reason = authenticationFailureReason(failure);
      const diagnostics = authenticationFailureDiagnostics(failure);

      context.observe({
        ...diagnostics,
        event: "oidc_authentication_failed",
        level: "warn",
        path: context.request.path,
        reason,
        userAgent: context.request.userAgent,
      });

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
  };
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
