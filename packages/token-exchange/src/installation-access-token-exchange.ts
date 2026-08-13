import type {
  GitHubAppConfiguration,
  GitHubAppDependencies,
} from "@github-app-token-broker/github/app";
import type { TokenIssuancePolicy } from "@github-app-token-broker/token-issuance-policy";
import {
  createIssueInstallationAccessToken,
  type InstallationAccessTokenIssuanceFailureReason,
} from "./installation-access-token-issuance.ts";
import type {
  AuthenticateSubjectToken,
  OidcAuthenticationFailureReason,
} from "./authentication.ts";
import type { TokenExchangeApplicationContext } from "./events.ts";
import type { InstallationAccessTokenRequest } from "@github-app-token-broker/github/installation-access-token-request";

type TokenExchangeAuthorizationFailureReason = Extract<
  InstallationAccessTokenIssuanceFailureReason,
  "requested_permissions_unsupported" | "subject_token_unacceptable" | "target_unsupported"
>;
type TokenExchangeIssuanceFailureReason = Exclude<
  InstallationAccessTokenIssuanceFailureReason,
  TokenExchangeAuthorizationFailureReason
>;

export type InstallationAccessTokenExchangeResult =
  | { readonly expiresAt: string; readonly ok: true; readonly token: string }
  | {
      readonly ok: false;
      readonly reason: OidcAuthenticationFailureReason;
      readonly stage: "authentication";
    }
  | {
      readonly ok: false;
      readonly reason: TokenExchangeAuthorizationFailureReason;
      readonly stage: "authorization";
    }
  | {
      readonly ok: false;
      readonly reason: TokenExchangeIssuanceFailureReason;
      readonly stage: "issuance";
    };

export interface InstallationAccessTokenExchangeCommand {
  readonly subjectToken: string;
  readonly tokenRequest: InstallationAccessTokenRequest;
}

export type ExchangeInstallationAccessToken = (
  command: InstallationAccessTokenExchangeCommand,
  context: TokenExchangeApplicationContext,
) => Promise<InstallationAccessTokenExchangeResult>;

export function createInstallationAccessTokenExchange(
  configuration: {
    readonly githubApp: GitHubAppConfiguration;
    readonly tokenIssuancePolicy: TokenIssuancePolicy;
  },
  dependencies: {
    readonly authenticateSubjectToken: AuthenticateSubjectToken;
    readonly githubAppDependencies: GitHubAppDependencies;
  },
): ExchangeInstallationAccessToken {
  const issueInstallationAccessToken = createIssueInstallationAccessToken(configuration, {
    githubAppDependencies: dependencies.githubAppDependencies,
  });

  return async (command, context) => {
    const authentication = await dependencies.authenticateSubjectToken(
      command.subjectToken,
      context,
    );

    if (!authentication.ok) {
      return {
        ok: false,
        reason: authentication.reason,
        stage: "authentication",
      };
    }

    const issuance = await issueInstallationAccessToken(
      authentication.context,
      command.tokenRequest,
      context.observe,
    );

    if (issuance.ok) {
      return issuance;
    }

    if (isAuthorizationFailure(issuance.reason)) {
      return {
        ok: false,
        reason: issuance.reason,
        stage: "authorization",
      };
    }

    return {
      ok: false,
      reason: issuance.reason,
      stage: "issuance",
    };
  };
}

function isAuthorizationFailure(
  reason: InstallationAccessTokenIssuanceFailureReason,
): reason is TokenExchangeAuthorizationFailureReason {
  return (
    reason === "requested_permissions_unsupported" ||
    reason === "subject_token_unacceptable" ||
    reason === "target_unsupported"
  );
}
