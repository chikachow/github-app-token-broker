import { googleServiceAccountOidcProviderRegistration } from "../../packages/oidc-provider-google-service-account/src/provider-registration.ts";
import { createFlyOidcProviderRegistration } from "../../packages/oidc-provider-fly/src/provider-registration.ts";
import { githubActionsOidcProviderRegistration } from "@github-app-token-broker/oidc-provider-github-actions";
import { buildkiteOidcProviderRegistration } from "@github-app-token-broker/oidc-provider-buildkite";
import {
  claimEquals,
  compileTokenIssuancePolicy,
  githubRepositoryResourceConstraint,
  oidcSubjectTokenConstraint,
} from "@github-app-token-broker/token-issuance-policy";

const flyRegistration = createFlyOidcProviderRegistration("example-org");

// Deliberately synthetic deployment inventory, independent of the driver's expectations.
export const composition = {
  githubApps: [
    {
      clientId: "Iv1.fixtureApp",
      slug: "fixture-app",
      privateKeyBinding: "GITHUB_APP_PRIVATE_KEY",
      subjectTokenAudiences: ["urn:integration:broker", "urn:integration:primary"],
    },
    {
      clientId: "Iv1.otherApp",
      slug: "other-app",
      privateKeyBinding: "OTHER_GITHUB_APP_PRIVATE_KEY",
      subjectTokenAudiences: ["urn:integration:broker", "urn:integration:other"],
    },
  ],
  oidcProviderRegistrations: [
    githubActionsOidcProviderRegistration,
    googleServiceAccountOidcProviderRegistration,
    flyRegistration,
    buildkiteOidcProviderRegistration,
  ],
  tokenIssuancePolicy: compileTokenIssuancePolicy([
    {
      permissions: { contents: "read", pull_requests: "read" },
      resource: githubRepositoryResourceConstraint("integration-owner", "target"),
      githubAppClientId: "Iv1.otherApp",
      subjectToken: oidcSubjectTokenConstraint(
        githubActionsOidcProviderRegistration.issuer,
        claimEquals("repository", "integration-owner/source"),
        claimEquals("ref", "refs/heads/main"),
      ),
    },
    {
      permissions: { contents: "write" },
      resource: githubRepositoryResourceConstraint("integration-buildkite-owner", "target"),
      githubAppClientId: "Iv1.fixtureApp",
      subjectToken: oidcSubjectTokenConstraint(
        buildkiteOidcProviderRegistration.issuer,
        claimEquals("pipeline_id", "55555555-5555-4555-8555-555555555555"),
      ),
    },
    {
      permissions: { contents: "write", pull_requests: "write" },
      resource: githubRepositoryResourceConstraint("integration-owner", "target"),
      githubAppClientId: "Iv1.fixtureApp",
      subjectToken: oidcSubjectTokenConstraint(
        googleServiceAccountOidcProviderRegistration.issuer,
        claimEquals("sub", "107517467455664443765"),
      ),
    },
    {
      permissions: { contents: "write", pull_requests: "write" },
      resource: githubRepositoryResourceConstraint("integration-owner", "target"),
      githubAppClientId: "Iv1.fixtureApp",
      subjectToken: oidcSubjectTokenConstraint(
        flyRegistration.issuer,
        claimEquals("app_name", "integration-app"),
      ),
    },
    {
      permissions: { contents: "write", pull_requests: "write" },
      resource: githubRepositoryResourceConstraint("integration-owner", "target"),
      githubAppClientId: "Iv1.fixtureApp",
      subjectToken: oidcSubjectTokenConstraint(
        githubActionsOidcProviderRegistration.issuer,
        claimEquals("repository", "integration-owner/source"),
        claimEquals("ref", "refs/heads/main"),
      ),
    },
  ]),
};
