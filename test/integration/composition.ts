import { githubActionsOidcProviderRegistration } from "@github-app-token-broker/oidc-provider-github-actions";
import {
  claimEquals,
  compileTokenIssuancePolicy,
  githubRepositoryResourceConstraint,
  oidcSubjectTokenConstraint,
} from "@github-app-token-broker/token-issuance-policy";

// Deliberately synthetic deployment inventory, independent of the driver's expectations.
export const composition = {
  oidcProviderRegistrations: [githubActionsOidcProviderRegistration],
  tokenIssuancePolicy: compileTokenIssuancePolicy([
    {
      permissions: { contents: "write", pull_requests: "write" },
      resource: githubRepositoryResourceConstraint("integration-owner", "target"),
      subjectToken: oidcSubjectTokenConstraint(
        githubActionsOidcProviderRegistration.issuer,
        claimEquals("repository", "integration-owner/source"),
        claimEquals("ref", "refs/heads/main"),
      ),
    },
  ]),
};
