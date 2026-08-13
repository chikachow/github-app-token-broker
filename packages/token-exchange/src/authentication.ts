import type {
  OidcIdTokenAuthenticationFailure,
  OidcIdTokenAuthenticator,
  OidcVerificationEvidence,
  VerifiedSubjectToken,
} from "@github-app-token-broker/oidc/id-token-authenticator";
import type { TokenExchangeAuthenticationEvent } from "./events.ts";

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
  observe: (event: TokenExchangeAuthenticationEvent) => void = () => undefined,
): Promise<AuthenticateRequestResult> {
  const authentication = await authenticator.authenticateIdToken(subjectToken, (event) =>
    observe({ ...event, level: "warn" }),
  );

  if (!authentication.ok) {
    const { failure } = authentication;
    const reason = authenticationFailureReason(failure);
    const diagnostics = authenticationFailureDiagnostics(failure);

    observe({
      ...diagnostics,
      event: "oidc_authentication_failed",
      level: "warn",
      path: new URL(request.url).pathname,
      reason,
      userAgent: request.headers.get("user-agent"),
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
