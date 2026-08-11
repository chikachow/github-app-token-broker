import { githubActionsOidcProviderRegistration } from "@github-app-token-broker/oidc-provider-github-actions";
import {
  createGitHubRepositoryResource,
  type GitHubInstallationPermissions,
  type InstallationAccessTokenRequest,
} from "../../workers/github-app-token-broker/src/installation-access-token-request.ts";
import type { VerifiedSubjectToken } from "../../workers/github-app-token-broker/src/authentication.ts";
import { createVerifiedSubjectToken } from "./oidc.ts";

type GitHubActionsWorkflowFileName = `${string}.${"yml" | "yaml"}`;
type GitHubRepositoryFullName = `${string}/${string}`;

interface GitHubActionsMainBranchWorkflowExpectationOptions {
  readonly eventNames: readonly string[];
  readonly permissions: GitHubInstallationPermissions;
  readonly resourceRepositoryFullName: GitHubRepositoryFullName;
  readonly workflowFileName: GitHubActionsWorkflowFileName;
  readonly workflowRepositoryFullName: GitHubRepositoryFullName;
}

interface DeploymentRepositoryUpdateExpectationsOptions {
  readonly deploymentRepositoryFullName: GitHubRepositoryFullName;
  readonly updateTriggerWorkflowFileName: GitHubActionsWorkflowFileName;
  readonly updateTriggerRepositoryFullName: GitHubRepositoryFullName;
  readonly updateWorkflowFileName: GitHubActionsWorkflowFileName;
}

export interface ConfiguredPermitStatementExpectation {
  readonly eventNames: readonly string[];
  readonly permissions: GitHubInstallationPermissions;
  readonly resourceRepositoryFullName: GitHubRepositoryFullName;
  readonly workflowRef: string;
  readonly workflowRepositoryFullName: string;
}

const mainBranchGitRef = "refs/heads/main";
const pullRequestAuthoringPermissions = {
  contents: "write",
  pull_requests: "write",
} as const;

export const configuredPermitStatementExpectations: readonly ConfiguredPermitStatementExpectation[] =
  [
    dependencyUpdateExpectation("chikachow/github-app-token-broker", "pnpm-up.yml"),
    ...deploymentRepositoryUpdateExpectations({
      deploymentRepositoryFullName: "chikachow/github-app-token-broker-deploy",
      updateTriggerWorkflowFileName: "run-github-app-token-broker-deploy-update.yml",
      updateTriggerRepositoryFullName: "chikachow/github-app-token-broker",
      updateWorkflowFileName: "update-github-app-token-broker.yml",
    }),
    dependencyUpdateExpectation("chikachow/cyspbot", "pnpm-up.yml"),
    ...deploymentRepositoryUpdateExpectations({
      deploymentRepositoryFullName: "chikachow/cyspbot-deploy",
      updateTriggerWorkflowFileName: "run-cyspbot-deploy-update.yml",
      updateTriggerRepositoryFullName: "chikachow/cyspbot",
      updateWorkflowFileName: "update-cyspbot.yml",
    }),
    dependencyUpdateExpectation("chikachow/cloudflare-workload-identity", "pnpm-up.yml"),
    ...deploymentRepositoryUpdateExpectations({
      deploymentRepositoryFullName: "chikachow/cloudflare-workload-identity-deploy",
      updateTriggerWorkflowFileName: "run-cloudflare-workload-identity-deploy-update.yml",
      updateTriggerRepositoryFullName: "chikachow/cloudflare-workload-identity",
      updateWorkflowFileName: "update-cloudflare-workload-identity.yml",
    }),
    dependencyUpdateExpectation("chikachow/cloudflare-workload-identity-deploy", "pnpm-up.yml"),
    dependencyUpdateExpectation("chikachow/cyspbot-app-token-action", "pnpm-up.yml"),
    dependencyUpdateExpectation("cysp/graphql-schema-registry", "pnpm-up.yml"),
    dependencyUpdateExpectation(
      "cysp/terraform-provider-braze",
      "update-indirect-dependencies.yml",
    ),
    dependencyUpdateExpectation(
      "cysp/terraform-provider-censusworkspace",
      "update-indirect-dependencies.yml",
    ),
    dependencyUpdateExpectation(
      "cysp/terraform-provider-contentful",
      "update-indirect-dependencies.yml",
    ),
    dependencyUpdateExpectation(
      "cysp/terraform-provider-typesense",
      "update-indirect-dependencies.yml",
    ),
  ];

export function subjectTokenForExpectation(
  expectation: ConfiguredPermitStatementExpectation,
  claims: Record<string, unknown> = {},
  options: { readonly issuer?: string } = {},
): VerifiedSubjectToken {
  return createVerifiedSubjectToken(
    {
      event_name: expectation.eventNames[0],
      ref: "refs/heads/main",
      ref_type: "branch",
      repository: expectation.workflowRepositoryFullName,
      repository_id: "123456789",
      repository_owner_id: "555555",
      sub: `repo:${expectation.workflowRepositoryFullName}:ref:refs/heads/main`,
      workflow_ref: expectation.workflowRef,
      ...claims,
    },
    { issuer: options.issuer ?? githubActionsOidcProviderRegistration.issuer },
  );
}

export function requestForExpectation(
  expectation: ConfiguredPermitStatementExpectation,
  permissions: GitHubInstallationPermissions,
  resourceRepositoryFullName: string = expectation.resourceRepositoryFullName,
): InstallationAccessTokenRequest {
  const [resourceOwner, resourceRepository] = splitGitHubRepositoryFullName(
    resourceRepositoryFullName,
  );

  return {
    permissions,
    resource: createGitHubRepositoryResource({
      owner: resourceOwner,
      repository: resourceRepository,
    }),
    scope: "configured-policy-test",
  };
}

function dependencyUpdateExpectation(
  repositoryFullName: GitHubRepositoryFullName,
  workflowFileName: GitHubActionsWorkflowFileName,
): ConfiguredPermitStatementExpectation {
  return githubActionsMainBranchWorkflowExpectation({
    eventNames: ["schedule", "workflow_dispatch"],
    permissions: pullRequestAuthoringPermissions,
    resourceRepositoryFullName: repositoryFullName,
    workflowFileName,
    workflowRepositoryFullName: repositoryFullName,
  });
}

function deploymentRepositoryUpdateExpectations(
  options: DeploymentRepositoryUpdateExpectationsOptions,
): readonly ConfiguredPermitStatementExpectation[] {
  return [
    githubActionsMainBranchWorkflowExpectation({
      eventNames: ["workflow_run", "workflow_dispatch"],
      permissions: { actions: "write" },
      resourceRepositoryFullName: options.deploymentRepositoryFullName,
      workflowFileName: options.updateTriggerWorkflowFileName,
      workflowRepositoryFullName: options.updateTriggerRepositoryFullName,
    }),
    githubActionsMainBranchWorkflowExpectation({
      eventNames: ["workflow_dispatch"],
      permissions: pullRequestAuthoringPermissions,
      resourceRepositoryFullName: options.deploymentRepositoryFullName,
      workflowFileName: options.updateWorkflowFileName,
      workflowRepositoryFullName: options.deploymentRepositoryFullName,
    }),
  ];
}

function githubActionsMainBranchWorkflowExpectation(
  options: GitHubActionsMainBranchWorkflowExpectationOptions,
): ConfiguredPermitStatementExpectation {
  const workflowRef = `${options.workflowRepositoryFullName}/.github/workflows/${options.workflowFileName}@${mainBranchGitRef}`;

  return {
    eventNames: options.eventNames,
    permissions: options.permissions,
    resourceRepositoryFullName: options.resourceRepositoryFullName,
    workflowRef,
    workflowRepositoryFullName: options.workflowRepositoryFullName,
  };
}

function splitGitHubRepositoryFullName(
  fullName: string,
): readonly [owner: string, repository: string] {
  return fullName.split("/", 2) as [owner: string, repository: string];
}
