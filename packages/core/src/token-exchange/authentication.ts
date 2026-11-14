import type {
  OidcIdTokenAuthenticationFailure,
  OidcIdTokenAuthenticator,
  OidcVerificationEvidence,
  VerifiedSubjectToken,
} from "../oidc/id-token-authenticator.ts";
import type { ObserveOidcDiagnostic, ObserveTokenExchange } from "./events.ts";
import { awaitTokenExchangeOperation } from "./lifetime.ts";

export interface SubjectTokenAuthenticationContext {
  readonly verificationEvidence: OidcVerificationEvidence;
  readonly verifiedSubjectToken: VerifiedSubjectToken;
}

export type OidcAuthenticationFailureReason =
  | "invalid_token"
  | "oidc_internal_failure"
  | "oidc_provider_failure";

interface AuthenticateOidcIdTokenFailure {
  ok: false;
  reason: OidcAuthenticationFailureReason;
}

interface AuthenticateOidcIdTokenSuccess {
  context: SubjectTokenAuthenticationContext;
  ok: true;
}

export type AuthenticateOidcIdTokenResult =
  | AuthenticateOidcIdTokenFailure
  | AuthenticateOidcIdTokenSuccess;

export async function authenticateOidcIdToken(
  subjectToken: string,
  request: Request,
  authenticator: OidcIdTokenAuthenticator,
  observe: ObserveTokenExchange,
  observeOidcDiagnostic?: ObserveOidcDiagnostic,
  waitUntil?: (operation: Promise<void>) => void,
): Promise<AuthenticateOidcIdTokenResult> {
  const pendingAuthentication = authenticator.authenticateIdToken(subjectToken, (event) => {
    try {
      observeOidcDiagnostic?.({ fields: event, level: "warn" });
    } catch {
      // Optional OIDC diagnostics must not affect authentication or token issuance.
    }
  });
  waitUntil?.(
    pendingAuthentication.then(
      () => undefined,
      () => undefined,
    ),
  );
  const authentication = await awaitTokenExchangeOperation(pendingAuthentication, request.signal);

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
