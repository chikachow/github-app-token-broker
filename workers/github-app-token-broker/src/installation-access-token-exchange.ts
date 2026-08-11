import type { GitHubAppDependencies, GitHubAppEnv } from "@github-app-token-broker/github/app";
import type { OidcIdTokenAuthenticator } from "@github-app-token-broker/oidc/id-token-authenticator";
import type { TokenIssuancePolicy } from "./policy/token-issuance-policy.ts";
import {
  type InstallationAccessTokenIssuanceFailureReason,
  issueInstallationAccessTokenForContext,
} from "./policy/installation-access-token-issuance.ts";
import { authenticateOidcIdToken, type OidcAuthenticationFailureReason } from "./authentication.ts";
import type { InstallationAccessTokenRequest } from "./installation-access-token-request.ts";

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

export interface InstallationAccessTokenExchange {
  exchange(input: {
    readonly githubApp: GitHubAppEnv;
    readonly request: Request;
    readonly subjectToken: string;
    readonly tokenRequest: InstallationAccessTokenRequest;
  }): Promise<InstallationAccessTokenExchangeResult>;
}

export function createInstallationAccessTokenExchange({
  githubAppDependencies,
  oidcIdTokenAuthenticator,
  tokenIssuancePolicy,
}: {
  githubAppDependencies: GitHubAppDependencies;
  oidcIdTokenAuthenticator: OidcIdTokenAuthenticator;
  tokenIssuancePolicy: TokenIssuancePolicy;
}): InstallationAccessTokenExchange {
  return {
    async exchange({ githubApp, request, subjectToken, tokenRequest }) {
      const authentication = await authenticateOidcIdToken(
        subjectToken,
        request,
        oidcIdTokenAuthenticator,
      );

      if (!authentication.ok) {
        return {
          ok: false,
          reason: authentication.reason,
          stage: "authentication",
        };
      }

      const issuance = await issueInstallationAccessTokenForContext(
        githubApp,
        tokenIssuancePolicy,
        authentication.context,
        tokenRequest,
        githubAppDependencies,
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
    },
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
