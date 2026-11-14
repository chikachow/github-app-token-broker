import { issueInstallationAccessToken } from "../github/app.ts";
import type {
  GitHubAppConfiguration,
  GitHubAppDependencies,
  GitHubInstallationAccessTokenIssuanceFailureReason,
} from "../github/app.ts";
import type { SubjectTokenAuthenticationContext } from "./authentication.ts";
import type { InstallationAccessTokenRequest } from "../github/installation-access-token-request.ts";
import type { TokenIssuancePolicy } from "../token-issuance-policy.ts";
import { evaluateTokenIssuancePolicy } from "../token-issuance-policy.ts";
import type { ObserveTokenExchange } from "./events.ts";
import {
  assertTokenExchangeActive,
  MandatoryObservationError,
  TokenExchangeUnavailableError,
} from "./lifetime.ts";

export type InstallationAccessTokenIssuanceFailureReason =
  | GitHubInstallationAccessTokenIssuanceFailureReason
  | "requested_permissions_unsupported"
  | "subject_token_unacceptable"
  | "target_unsupported";

export type InstallationAccessTokenIssuanceResult =
  | {
      expiresAt: string;
      ok: true;
      token: string;
      discard(stage: "expiry" | "lifetime" | "response"): Promise<void>;
    }
  | { ok: false; reason: InstallationAccessTokenIssuanceFailureReason };

interface InstallationAccessTokenIssuanceInput {
  readonly authenticationContext: SubjectTokenAuthenticationContext;
  readonly dependencies: GitHubAppDependencies;
  readonly githubApp: GitHubAppConfiguration;
  readonly installationAccessTokenRequest: InstallationAccessTokenRequest;
  readonly observe: ObserveTokenExchange;
  readonly signal: AbortSignal;
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
    signal,
    tokenIssuancePolicy,
  } = input;
  const { verifiedSubjectToken } = authenticationContext;
  assertTokenExchangeActive(signal);
  const policyEvaluation = evaluateTokenIssuancePolicy(
    tokenIssuancePolicy,
    verifiedSubjectToken,
    installationAccessTokenRequest,
    githubApp.clientId,
  );
  const issuanceObservationFields = () => ({
    github_app: { client_id: githubApp.clientId },
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

  const requestedRepositoryFullName = `${installationAccessTokenRequest.resource.owner}/${installationAccessTokenRequest.resource.repository}`;

  await observe({
    fields: {
      event: "installation_access_token_issuance_started",
      ...issuanceObservationFields(),
      target_installation: {
        id: undefined,
        repository: requestedRepositoryFullName,
      },
    },
    level: "info",
  });

  const issuance = await issueInstallationAccessToken(
    githubApp,
    installationAccessTokenRequest,
    dependencies,
    signal,
  );

  if (!issuance.ok) {
    if (issuance.revocationOutcome !== undefined) {
      observeReleaseFailure(githubApp.clientId, "upstream_response", issuance.revocationOutcome);
    }
    assertTokenExchangeActive(signal);
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
    assertTokenExchangeActive(signal);
    await observe({
      fields: {
        event: "installation_access_token_issuance_succeeded",
        expires_at: issuance.expiresAt,
        ...issuanceObservationFields(),
        target_installation: {
          id: issuance.installationId,
          repository: requestedRepositoryFullName,
        },
        installation_access_token: {
          permissions: issuance.permissions,
        },
      },
      level: "info",
    });
    assertTokenExchangeActive(signal);
  } catch (error) {
    await discardIssuedToken(
      issuance,
      githubApp.clientId,
      error instanceof MandatoryObservationError ? "observation" : "lifetime",
    );
    if (error instanceof TokenExchangeUnavailableError) throw error;
    throw new MandatoryObservationError();
  }

  return {
    expiresAt: issuance.expiresAt,
    ok: true,
    token: issuance.token,
    discard: (stage) => discardIssuedToken(issuance, githubApp.clientId, stage),
  };
}

async function discardIssuedToken(
  issuance: { revoke(): Promise<void> },
  clientId: string,
  stage: "observation" | "expiry" | "lifetime" | "response",
): Promise<void> {
  let outcome: "succeeded" | "failed" = "succeeded";
  try {
    await issuance.revoke();
  } catch {
    outcome = "failed";
  }
  observeReleaseFailure(clientId, stage, outcome);
}

function observeReleaseFailure(
  clientId: string,
  stage: "observation" | "expiry" | "lifetime" | "upstream_response" | "response",
  revocationOutcome: "succeeded" | "failed",
): void {
  try {
    console.error({
      event: "installation_access_token_release_failed",
      github_app: { client_id: clientId },
      stage,
      revocation_outcome: revocationOutcome,
    });
  } catch {
    // Independent fallback reporting cannot change the terminal outcome.
  }
}

function subjectTokenLogFields(
  authenticationContext: SubjectTokenAuthenticationContext,
): Record<string, unknown> {
  return {
    issuer: authenticationContext.verifiedSubjectToken.issuer,
    id_token_header_key_id: authenticationContext.verificationEvidence.idTokenHeaderKeyId,
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
