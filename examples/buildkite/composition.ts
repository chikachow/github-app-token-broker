import { buildkiteOidcProviderRegistration } from "@github-app-token-broker/oidc-provider-buildkite";
import type { TokenExchangeComposition } from "@github-app-token-broker/token-exchange";
import {
  claimEquals,
  compileTokenIssuancePolicy,
  githubRepositoryResourceConstraint,
  oidcSubjectTokenConstraint,
} from "@github-app-token-broker/token-issuance-policy";

// Synthetic composition recipe: the deployment must already trust pipeline editing, build
// creation, fork handling, and agent execution. Branch and step Claims narrow
// this grant but do not establish code provenance or exclude trigger sources.
export const buildkiteExampleComposition = {
  oidcProviderRegistrations: [buildkiteOidcProviderRegistration],
  tokenIssuancePolicy: compileTokenIssuancePolicy([
    {
      permissions: { contents: "write" },
      resource: githubRepositoryResourceConstraint("example-owner", "target"),
      subjectToken: oidcSubjectTokenConstraint(
        buildkiteOidcProviderRegistration.issuer,
        claimEquals("organization_id", "11111111-1111-4111-8111-111111111111"),
        claimEquals("pipeline_id", "22222222-2222-4222-8222-222222222222"),
        claimEquals("build_branch", "main"),
        claimEquals("step_key", "publish"),
      ),
    },
  ]),
} satisfies TokenExchangeComposition;
