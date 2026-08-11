import { githubActionsOidcProviderRegistration } from "@github-app-token-broker/oidc-provider-github-actions";
import {
  claimEquals,
  claimOneOf,
  compileTokenIssuancePolicy,
  githubRepositoryResourceConstraint,
  oidcSubjectTokenConstraint,
} from "@github-app-token-broker/token-issuance-policy";
import { createVerifiedSubjectToken } from "./oidc.ts";

import {
  testRepository,
  testRepositoryId,
  testRepositoryOwnerId,
  testRepositoryVisibility,
  testWorkflowDispatchRepository,
} from "./constants.ts";

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

export const testSubjectConstraintMatchingVerifiedSubjectToken = createVerifiedSubjectToken(
  {
    actor: "dependabot[bot]",
    event_name: "workflow_dispatch",
    ref: testGitRef,
    ref_type: "branch",
    repository: testRepository,
    repository_id: testRepositoryId,
    repository_owner_id: testRepositoryOwnerId,
    repository_visibility: testRepositoryVisibility,
    run_attempt: "1",
    run_id: "987654321",
    sha: "0123456789abcdef0123456789abcdef01234567",
    sub: `repo:${testRepository}:ref:${testGitRef}`,
    workflow: "fixture token request",
    workflow_ref: testWorkflowRef,
  },
  { issuer: githubActionsOidcProviderRegistration.issuer },
);

function repositoryParts(repository: string): [string, string] {
  const [owner, name, extra] = repository.split("/");

  if (owner === undefined || name === undefined || extra !== undefined) {
    throw new Error("invalid test repository");
  }

  return [owner, name];
}
