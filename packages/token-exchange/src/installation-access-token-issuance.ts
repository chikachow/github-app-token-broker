import { issueInstallationAccessToken } from "@github-app-token-broker/github/app";
import type {
  GitHubAppConfiguration,
  GitHubAppDependencies,
  GitHubInstallationAccessTokenIssuanceFailureReason,
} from "@github-app-token-broker/github/app";
import type { AuthenticatedContext } from "./authentication.ts";
import type { InstallationAccessTokenRequest } from "@github-app-token-broker/github/installation-access-token-request";
import type { TokenIssuancePolicy } from "@github-app-token-broker/token-issuance-policy";
import { evaluateTokenIssuancePolicy } from "@github-app-token-broker/token-issuance-policy";
import type { ObserveTokenExchange } from "./events.ts";

export type InstallationAccessTokenIssuanceFailureReason =
  | GitHubInstallationAccessTokenIssuanceFailureReason
  | "requested_permissions_unsupported"
  | "subject_token_unacceptable"
  | "target_unsupported";

export type InstallationAccessTokenIssuanceResult =
  | { expiresAt: string; ok: true; token: string }
  | { ok: false; reason: InstallationAccessTokenIssuanceFailureReason };

interface InstallationAccessTokenIssuanceInput {
  readonly authenticationContext: AuthenticatedContext;
  readonly dependencies: GitHubAppDependencies;
  readonly githubApp: GitHubAppConfiguration;
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
  const issuanceObservationFields = () => ({
    installation_access_token_request: installationAccessTokenRequestLogFields(
      installationAccessTokenRequest,
    ),
    subject_token: subjectTokenLogFields(authenticationContext),
    token_issuance_policy: {
      outcome: policyEvaluation.outcome,
    },
  });

  if (policyEvaluation.outcome !== "permitted") {
    await observe({
      fields: {
        error: {
          message: "Token Issuance Policy did not permit Installation Access Token Issuance",
          name: "Error",
          status: undefined,
        },
        event: "installation_access_token_issuance_failed",
        ...issuanceObservationFields(),
        target_installation: {
          id: undefined,
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
      ...issuanceObservationFields(),
      target_installation: {
        id: undefined,
        repository: requestedResourceName,
      },
    },
    level: "info",
  });

  const issuance = await issueInstallationAccessToken(
    githubApp,
    installationAccessTokenRequest,
    dependencies,
  );

  if (!issuance.ok) {
    await observe({
      fields: {
        error: {
          message: issuance.error.message,
          name: issuance.error.name,
          status: issuance.error.status,
          upstream_status: issuance.error.upstreamStatus,
        },
        event: "installation_access_token_issuance_failed",
        ...issuanceObservationFields(),
        target_installation: {
          id: issuance.installationId,
        },
      },
      level: "error",
    });

    return { ok: false, reason: issuance.reason };
  }

  try {
    await observe({
      fields: {
        event: "installation_access_token_issuance_succeeded",
        expires_at: issuance.expiresAt,
        ...issuanceObservationFields(),
        target_installation: {
          id: issuance.installationId,
          repository: requestedResourceName,
        },
        installation_access_token: {
          permissions: issuance.permissions,
        },
      },
      level: "info",
    });
  } catch {
    try {
      await issuance.revoke();
    } catch {
      // Revocation is best effort; the minted token must never be returned either way.
    }

    throw new Error("mandatory Token Exchange observation was not acknowledged");
  }

  return {
    expiresAt: issuance.expiresAt,
    ok: true,
    token: issuance.token,
  };
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
