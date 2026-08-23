import {
  GitHubAppConfigurationError,
  GitHubInstallationAccessTokenIssuanceError,
  issueInstallationAccessTokenForRepository,
} from "@github-app-token-broker/github/app";
import {
  GitHubApiError,
  GitHubApiTransportError,
  revokeGitHubInstallationAccessToken,
} from "@github-app-token-broker/github/http";
import type { GitHubAppDependencies, GitHubAppEnv } from "@github-app-token-broker/github/app";
import type { AuthenticatedContext } from "../authentication.ts";
import type { InstallationAccessTokenRequest } from "@github-app-token-broker/github/installation-access-token-request";
import type { TokenIssuancePolicy } from "@github-app-token-broker/token-issuance-policy";
import { evaluateTokenIssuancePolicy } from "@github-app-token-broker/token-issuance-policy";
import type { ObserveTokenExchange } from "../observability.ts";

export type InstallationAccessTokenIssuanceFailureReason =
  | "internal_failure"
  | "requested_permissions_unsupported"
  | "subject_token_unacceptable"
  | "target_unsupported"
  | "upstream_failure"
  | "upstream_unavailable";

export type InstallationAccessTokenIssuanceResult =
  | { expiresAt: string; ok: true; token: string }
  | { ok: false; reason: InstallationAccessTokenIssuanceFailureReason };

interface InstallationAccessTokenIssuanceInput {
  readonly authenticationContext: AuthenticatedContext;
  readonly dependencies: GitHubAppDependencies;
  readonly githubApp: GitHubAppEnv;
  readonly installationAccessTokenRequest: InstallationAccessTokenRequest;
  readonly observe: ObserveTokenExchange;
  readonly tokenIssuancePolicy: TokenIssuancePolicy;
}

export async function issueInstallationAccessTokenForContext(
  input: InstallationAccessTokenIssuanceInput,
): Promise<InstallationAccessTokenIssuanceResult> {
  const {
    authenticationContext,
    dependencies,
    githubApp,
    installationAccessTokenRequest,
    observe,
    tokenIssuancePolicy,
  } = input;
  const { verifiedSubjectToken } = authenticationContext;
  const policyEvaluation = evaluateTokenIssuancePolicy(
    tokenIssuancePolicy,
    verifiedSubjectToken,
    installationAccessTokenRequest,
  );

  if (policyEvaluation.outcome !== "permitted") {
    await observe({
      fields: {
        error: {
          message: "Token Issuance Policy did not permit Installation Access Token Issuance",
          name: "Error",
          status: undefined,
        },
        event: "installation_access_token_issuance_failed",
        installation_access_token_request: installationAccessTokenRequestLogFields(
          installationAccessTokenRequest,
        ),
        subject_token: subjectTokenLogFields(authenticationContext),
        target_installation: {
          id: undefined,
        },
        token_issuance_policy: {
          outcome: policyEvaluation.outcome,
        },
      },
      level: "error",
    });

    return {
      ok: false,
      reason: policyEvaluation.outcome,
    };
  }

  const requestedResourceName = `${installationAccessTokenRequest.resource.owner}/${installationAccessTokenRequest.resource.repository}`;

  await observe({
    fields: {
      event: "installation_access_token_issuance_started",
      installation_access_token_request: installationAccessTokenRequestLogFields(
        installationAccessTokenRequest,
      ),
      subject_token: subjectTokenLogFields(authenticationContext),
      target_installation: {
        id: undefined,
        repository: requestedResourceName,
      },
      token_issuance_policy: {
        outcome: policyEvaluation.outcome,
      },
    },
    level: "info",
  });

  let installationAccessToken: Awaited<
    ReturnType<typeof issueInstallationAccessTokenForRepository>
  >;

  try {
    installationAccessToken = await issueInstallationAccessTokenForRepository(
      githubApp,
      installationAccessTokenRequest.resource,
      installationAccessTokenRequest.permissions,
      dependencies,
    );
  } catch (error) {
    const classifiedError =
      error instanceof GitHubInstallationAccessTokenIssuanceError ? error.cause : error;
    const reason = reasonForInstallationAccessTokenIssuanceError(classifiedError);

    await observe({
      fields: {
        error: {
          message: logMessageForInstallationAccessTokenIssuanceError(classifiedError),
          name: logNameForInstallationAccessTokenIssuanceError(classifiedError),
          status: classifiedError instanceof GitHubApiError ? classifiedError.status : undefined,
          upstream_status:
            classifiedError instanceof GitHubApiError ? classifiedError.upstreamStatus : undefined,
        },
        event: "installation_access_token_issuance_failed",
        installation_access_token_request: installationAccessTokenRequestLogFields(
          installationAccessTokenRequest,
        ),
        subject_token: subjectTokenLogFields(authenticationContext),
        target_installation: {
          id:
            error instanceof GitHubInstallationAccessTokenIssuanceError
              ? error.installationId
              : undefined,
        },
        token_issuance_policy: {
          outcome: policyEvaluation.outcome,
        },
      },
      level: "error",
    });

    return { ok: false, reason };
  }

  try {
    await observe({
      fields: {
        event: "installation_access_token_issuance_succeeded",
        expires_at: installationAccessToken.expiresAt,
        installation_access_token_request: installationAccessTokenRequestLogFields(
          installationAccessTokenRequest,
        ),
        subject_token: subjectTokenLogFields(authenticationContext),
        target_installation: {
          id: installationAccessToken.installationId,
          repository: requestedResourceName,
        },
        installation_access_token: {
          permissions: installationAccessToken.permissions,
        },
        token_issuance_policy: {
          outcome: policyEvaluation.outcome,
        },
      },
      level: "info",
    });
  } catch {
    try {
      await revokeGitHubInstallationAccessToken(dependencies, installationAccessToken.token);
    } catch {
      // Revocation is best effort; the minted token must never be returned either way.
    }

    throw new Error("mandatory Token Exchange observation was not acknowledged");
  }

  return {
    expiresAt: installationAccessToken.expiresAt,
    ok: true,
    token: installationAccessToken.token,
  };
}

function reasonForInstallationAccessTokenIssuanceError(
  error: unknown,
): InstallationAccessTokenIssuanceFailureReason {
  if (error instanceof GitHubApiTransportError) {
    return "upstream_unavailable";
  }

  if (error instanceof GitHubApiError) {
    if (error.rateLimited || error.status === 503) {
      return "upstream_unavailable";
    }

    if (error.status === 400 || error.status === 401 || error.status === 422) {
      return "internal_failure";
    }

    if (error.status === 403 || error.status === 404 || error.status >= 500) {
      return "upstream_failure";
    }
  }

  return "internal_failure";
}

function logMessageForInstallationAccessTokenIssuanceError(error: unknown): string {
  if (
    error instanceof GitHubApiError ||
    error instanceof GitHubApiTransportError ||
    error instanceof GitHubAppConfigurationError
  ) {
    return error.message;
  }

  return "unexpected Installation Access Token Issuance error";
}

function logNameForInstallationAccessTokenIssuanceError(error: unknown): string {
  if (error instanceof GitHubApiError) {
    return "GitHubApiError";
  }

  if (error instanceof GitHubApiTransportError) {
    return "GitHubApiTransportError";
  }

  if (error instanceof GitHubAppConfigurationError) {
    return "GitHubAppConfigurationError";
  }

  return "Error";
}

function subjectTokenLogFields(
  authenticationContext: AuthenticatedContext,
): Record<string, unknown> {
  return {
    issuer: authenticationContext.verifiedSubjectToken.issuer,
    resolved_key_id: authenticationContext.verificationEvidence.resolvedKeyId,
    sub: authenticationContext.verifiedSubjectToken.claims.sub,
    subject_token_kind: "id_token",
  };
}

function installationAccessTokenRequestLogFields(
  installationAccessTokenRequest: InstallationAccessTokenRequest,
): Record<string, unknown> {
  return {
    permissions: installationAccessTokenRequest.permissions,
    resource: installationAccessTokenRequest.resource.href,
    scope: installationAccessTokenRequest.scope,
  };
}
