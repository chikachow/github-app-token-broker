import {
  createInstallationAccessTokenForRepositoryName,
  GitHubAppConfigurationError,
  resolveInstallationForRepository,
} from "@github-app-token-broker/github/app";
import { GitHubApiError, GitHubApiTransportError } from "@github-app-token-broker/github/http";
import type {
  GitHubAppConfiguration,
  GitHubAppDependencies,
} from "@github-app-token-broker/github/app";
import type { AuthenticatedContext } from "./authentication.ts";
import type { TokenExchangeEvent } from "./events.ts";
import type { InstallationAccessTokenRequest } from "@github-app-token-broker/github/installation-access-token-request";
import type { TokenIssuancePolicy } from "@github-app-token-broker/token-issuance-policy";
import {
  tokenIssuancePolicyPermits,
  tokenIssuancePolicySupportsRequestedPermissions,
  tokenIssuancePolicySupportsTarget,
} from "@github-app-token-broker/token-issuance-policy";

export type InstallationAccessTokenIssuanceFailureReason =
  | "internal_failure"
  | "requested_permissions_unsupported"
  | "subject_token_unacceptable"
  | "target_unsupported"
  | "upstream_failure"
  | "upstream_unavailable";

type InstallationAccessTokenIssuanceResult =
  | { expiresAt: string; ok: true; token: string }
  | { ok: false; reason: InstallationAccessTokenIssuanceFailureReason };

export interface InstallationAccessTokenIssuanceOperations {
  readonly createInstallationAccessTokenForRepositoryName: typeof createInstallationAccessTokenForRepositoryName;
  readonly resolveInstallationForRepository: typeof resolveInstallationForRepository;
}

const defaultInstallationAccessTokenIssuanceOperations = {
  createInstallationAccessTokenForRepositoryName,
  resolveInstallationForRepository,
} satisfies InstallationAccessTokenIssuanceOperations;

export type IssueInstallationAccessToken = (
  authenticationContext: AuthenticatedContext,
  tokenRequest: InstallationAccessTokenRequest,
  observe: (event: TokenExchangeEvent) => void,
) => Promise<InstallationAccessTokenIssuanceResult>;

export function createIssueInstallationAccessToken(
  configuration: {
    readonly githubApp: GitHubAppConfiguration;
    readonly tokenIssuancePolicy: TokenIssuancePolicy;
  },
  dependencies: {
    readonly githubAppDependencies: GitHubAppDependencies;
    readonly operations?: InstallationAccessTokenIssuanceOperations;
  },
): IssueInstallationAccessToken {
  const operations = dependencies.operations ?? defaultInstallationAccessTokenIssuanceOperations;

  return async (authenticationContext, installationAccessTokenRequest, observe) => {
    const { verifiedSubjectToken } = authenticationContext;
    const policyPermitted = tokenIssuancePolicyPermits(
      configuration.tokenIssuancePolicy,
      verifiedSubjectToken,
      installationAccessTokenRequest,
    );

    if (!policyPermitted) {
      const targetSupported = tokenIssuancePolicySupportsTarget(
        configuration.tokenIssuancePolicy,
        installationAccessTokenRequest,
      );
      const requestedPermissionsSupported =
        targetSupported &&
        tokenIssuancePolicySupportsRequestedPermissions(
          configuration.tokenIssuancePolicy,
          installationAccessTokenRequest,
        );

      observe({
        error: {
          message: "Token Issuance Policy did not permit Installation Access Token Issuance",
          name: "Error",
          status: undefined,
        },
        event: "installation_access_token_issuance_failed",
        level: "error",
        installation_access_token_request: installationAccessTokenRequestLogFields(
          installationAccessTokenRequest,
        ),
        subject_token: subjectTokenLogFields(authenticationContext),
        target_installation: {
          id: undefined,
        },
        token_issuance_policy: {
          permitted: false,
        },
      });

      return {
        ok: false,
        reason: !targetSupported
          ? "target_unsupported"
          : !requestedPermissionsSupported
            ? "requested_permissions_unsupported"
            : "subject_token_unacceptable",
      };
    }

    let targetInstallationId: number | undefined;

    try {
      const requestedResourceName = `${installationAccessTokenRequest.resource.owner}/${installationAccessTokenRequest.resource.repository}`;
      const targetInstallation = await operations.resolveInstallationForRepository(
        configuration.githubApp,
        requestedResourceName,
        dependencies.githubAppDependencies,
      );
      targetInstallationId = targetInstallation.id;
      const installationAccessToken =
        await operations.createInstallationAccessTokenForRepositoryName(
          configuration.githubApp,
          targetInstallation.id,
          installationAccessTokenRequest.resource.repository,
          { ...installationAccessTokenRequest.permissions },
          dependencies.githubAppDependencies,
        );

      observe({
        event: "installation_access_token_issuance_succeeded",
        level: "info",
        expires_at: installationAccessToken.expiresAt,
        installation_access_token_request: installationAccessTokenRequestLogFields(
          installationAccessTokenRequest,
        ),
        subject_token: subjectTokenLogFields(authenticationContext),
        target_installation: {
          id: targetInstallation.id,
          repository: requestedResourceName,
        },
        token_issuance_policy: {
          permitted: true,
        },
      });

      return {
        expiresAt: installationAccessToken.expiresAt,
        ok: true,
        token: installationAccessToken.token,
      };
    } catch (error) {
      const reason = reasonForInstallationAccessTokenIssuanceError(error);

      observe({
        error: {
          message: logMessageForInstallationAccessTokenIssuanceError(error),
          name: error instanceof Error ? error.name : typeof error,
          status: error instanceof GitHubApiError ? error.upstreamStatus : undefined,
        },
        event: "installation_access_token_issuance_failed",
        level: "error",
        installation_access_token_request: installationAccessTokenRequestLogFields(
          installationAccessTokenRequest,
        ),
        subject_token: subjectTokenLogFields(authenticationContext),
        target_installation: {
          id: targetInstallationId,
        },
        token_issuance_policy: {
          permitted: true,
        },
      });

      return { ok: false, reason };
    }
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
