import { githubActionsOidcProviderRegistration } from "@github-app-token-broker/oidc-provider-github-actions";
import {
  claimEquals,
  claimOneOf,
  compileTokenIssuancePolicy,
  githubRepositoryResourceConstraint,
  oidcSubjectTokenConstraint,
} from "@github-app-token-broker/token-issuance-policy";

import { testRepository, testWorkflowDispatchRepository } from "./constants.ts";

const testGitRef = "refs/heads/fixture-base-branch";
const testWorkflowRef = `${testRepository}/.github/workflows/fixture-token-request.yml@${testGitRef}`;

const testSubjectTokenConstraint = oidcSubjectTokenConstraint(
  githubActionsOidcProviderRegistration.issuer,
  claimEquals("repository", testRepository),
  claimOneOf("event_name", ["schedule", "workflow_dispatch"]),
  claimEquals("ref_type", "branch"),
  claimEquals("ref", testGitRef),
  claimEquals("workflow_ref", testWorkflowRef),
);

export const testTokenIssuancePolicy = compileTokenIssuancePolicy([
  {
    permissions: { contents: "write", pull_requests: "write" },
    resource: githubRepositoryResourceConstraint(...repositoryParts(testRepository)),
    subjectToken: testSubjectTokenConstraint,
  },
  {
    permissions: { actions: "write" },
    resource: githubRepositoryResourceConstraint(
      ...repositoryParts(testWorkflowDispatchRepository),
    ),
    subjectToken: testSubjectTokenConstraint,
  },
]);

function repositoryParts(repository: string): [string, string] {
  const [owner, name, extra] = repository.split("/");

  if (owner === undefined || name === undefined || extra !== undefined) {
    throw new Error("invalid test repository");
  }

  return [owner, name];
}
