import type {
  GitHubAppConfiguration,
  GitHubAppDependencies,
} from "@github-app-token-broker/github/app";
import type { OidcIdTokenAuthenticator } from "@github-app-token-broker/oidc/id-token-authenticator";
import type { TokenIssuancePolicy } from "@github-app-token-broker/token-issuance-policy";
import {
  type InstallationAccessTokenIssuanceFailureReason,
  issueInstallationAccessTokenForContext,
} from "./installation-access-token-issuance.ts";
import { authenticateOidcIdToken, type OidcAuthenticationFailureReason } from "./authentication.ts";
import type { InstallationAccessTokenRequest } from "@github-app-token-broker/github/installation-access-token-request";
import type { TokenExchangeRequestContext } from "./events.ts";

// A shared reason would make origin-dependent OAuth mapping ambiguous.
export type InstallationAccessTokenExchangeFailureReason = [
  Extract<OidcAuthenticationFailureReason, InstallationAccessTokenIssuanceFailureReason>,
] extends [never]
  ? OidcAuthenticationFailureReason | InstallationAccessTokenIssuanceFailureReason
  : never;

type InstallationAccessTokenExchangeResult =
  | { readonly expiresAt: string; readonly ok: true; readonly token: string }
  | {
      readonly ok: false;
      readonly reason: InstallationAccessTokenExchangeFailureReason;
    };

export type InstallationAccessTokenExchange = (
  input: {
    readonly request: Request;
    readonly subjectToken: string;
    readonly tokenRequest: InstallationAccessTokenRequest;
  },
  context: TokenExchangeRequestContext,
) => Promise<InstallationAccessTokenExchangeResult>;

export function createInstallationAccessTokenExchange({
  githubApp,
  githubAppDependencies,
  oidcIdTokenAuthenticator,
  tokenIssuancePolicy,
}: {
  githubApp: GitHubAppConfiguration;
  githubAppDependencies: GitHubAppDependencies;
  oidcIdTokenAuthenticator: OidcIdTokenAuthenticator;
  tokenIssuancePolicy: TokenIssuancePolicy;
}): InstallationAccessTokenExchange {
  return async ({ request, subjectToken, tokenRequest }, context) => {
    const authentication = await authenticateOidcIdToken(
      subjectToken,
      request,
      oidcIdTokenAuthenticator,
      context.observe,
      context.observeOidcDiagnostic,
    );

    if (!authentication.ok) {
      return {
        ok: false,
        reason: authentication.reason,
      };
    }

    return issueInstallationAccessTokenForContext({
      authenticationContext: authentication.context,
      dependencies: githubAppDependencies,
      githubApp,
      installationAccessTokenRequest: tokenRequest,
      observe: context.observe,
      tokenIssuancePolicy,
    });
  };
}
