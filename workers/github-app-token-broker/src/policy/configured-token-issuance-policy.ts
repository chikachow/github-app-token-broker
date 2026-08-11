import { githubActionsOidcProviderRegistration } from "../configured-oidc-provider-registrations.ts";
import { createGitHubRepositoryResource } from "../installation-access-token-request.ts";
import {
  claimEquals,
  claimOneOf,
  compileTokenIssuancePolicy,
  githubRepositoryResourceConstraint,
  oidcSubjectTokenConstraint,
  type PermitStatementDefinition,
} from "./token-issuance-policy.ts";

type GitHubActionsWorkflowFileName = `${string}.${"yml" | "yaml"}`;
type GitHubRepositoryFullName = `${string}/${string}`;

interface DeploymentRepositoryUpdatePermitStatementsOptions {
  readonly deploymentRepositoryFullName: GitHubRepositoryFullName;
  readonly updateTriggerWorkflowFileName: GitHubActionsWorkflowFileName;
  readonly updateTriggerRepositoryFullName: GitHubRepositoryFullName;
  readonly updateWorkflowFileName: GitHubActionsWorkflowFileName;
}

interface GitHubActionsMainBranchWorkflowPermitStatementOptions {
  readonly eventNames: readonly string[];
  readonly permissions: PermitStatementDefinition["permissions"];
  readonly resourceRepositoryFullName: GitHubRepositoryFullName;
  readonly workflowFileName: GitHubActionsWorkflowFileName;
  readonly workflowRepositoryFullName: GitHubRepositoryFullName;
}

const mainBranchGitRef = "refs/heads/main";
const pullRequestAuthoringPermissions = {
  contents: "write",
  pull_requests: "write",
} as const;

export const configuredTokenIssuancePolicy = compileTokenIssuancePolicy([
  dependencyUpdatePermitStatement("chikachow/github-app-token-broker", "pnpm-up.yml"),
  ...deploymentRepositoryUpdatePermitStatements({
    deploymentRepositoryFullName: "chikachow/github-app-token-broker-deploy",
    updateTriggerWorkflowFileName: "run-github-app-token-broker-deploy-update.yml",
    updateTriggerRepositoryFullName: "chikachow/github-app-token-broker",
    updateWorkflowFileName: "update-github-app-token-broker.yml",
  }),
  dependencyUpdatePermitStatement("chikachow/cyspbot", "pnpm-up.yml"),
  ...deploymentRepositoryUpdatePermitStatements({
    deploymentRepositoryFullName: "chikachow/cyspbot-deploy",
    updateTriggerWorkflowFileName: "run-cyspbot-deploy-update.yml",
    updateTriggerRepositoryFullName: "chikachow/cyspbot",
    updateWorkflowFileName: "update-cyspbot.yml",
  }),
  dependencyUpdatePermitStatement("chikachow/cloudflare-workload-identity", "pnpm-up.yml"),
  ...deploymentRepositoryUpdatePermitStatements({
    deploymentRepositoryFullName: "chikachow/cloudflare-workload-identity-deploy",
    updateTriggerWorkflowFileName: "run-cloudflare-workload-identity-deploy-update.yml",
    updateTriggerRepositoryFullName: "chikachow/cloudflare-workload-identity",
    updateWorkflowFileName: "update-cloudflare-workload-identity.yml",
  }),
  dependencyUpdatePermitStatement("chikachow/cloudflare-workload-identity-deploy", "pnpm-up.yml"),
  dependencyUpdatePermitStatement("chikachow/cyspbot-app-token-action", "pnpm-up.yml"),
  dependencyUpdatePermitStatement("cysp/graphql-schema-registry", "pnpm-up.yml"),
  dependencyUpdatePermitStatement(
    "cysp/terraform-provider-braze",
    "update-indirect-dependencies.yml",
  ),
  dependencyUpdatePermitStatement(
    "cysp/terraform-provider-censusworkspace",
    "update-indirect-dependencies.yml",
  ),
  dependencyUpdatePermitStatement(
    "cysp/terraform-provider-contentful",
    "update-indirect-dependencies.yml",
  ),
  dependencyUpdatePermitStatement(
    "cysp/terraform-provider-typesense",
    "update-indirect-dependencies.yml",
  ),
]);

function dependencyUpdatePermitStatement(
  repositoryFullName: GitHubRepositoryFullName,
  workflowFileName: GitHubActionsWorkflowFileName,
): PermitStatementDefinition {
  return githubActionsMainBranchWorkflowPermitStatement({
    eventNames: ["schedule", "workflow_dispatch"],
    permissions: pullRequestAuthoringPermissions,
    resourceRepositoryFullName: repositoryFullName,
    workflowFileName,
    workflowRepositoryFullName: repositoryFullName,
  });
}

function deploymentRepositoryUpdatePermitStatements(
  options: DeploymentRepositoryUpdatePermitStatementsOptions,
): readonly PermitStatementDefinition[] {
  return [
    githubActionsMainBranchWorkflowPermitStatement({
      eventNames: ["workflow_run", "workflow_dispatch"],
      permissions: { actions: "write" },
      resourceRepositoryFullName: options.deploymentRepositoryFullName,
      workflowFileName: options.updateTriggerWorkflowFileName,
      workflowRepositoryFullName: options.updateTriggerRepositoryFullName,
    }),
    githubActionsMainBranchWorkflowPermitStatement({
      eventNames: ["workflow_dispatch"],
      permissions: pullRequestAuthoringPermissions,
      resourceRepositoryFullName: options.deploymentRepositoryFullName,
      workflowFileName: options.updateWorkflowFileName,
      workflowRepositoryFullName: options.deploymentRepositoryFullName,
    }),
  ];
}

function githubActionsMainBranchWorkflowPermitStatement(
  options: GitHubActionsMainBranchWorkflowPermitStatementOptions,
): PermitStatementDefinition {
  const resourceParts = parseGitHubRepositoryFullName(options.resourceRepositoryFullName);
  const workflowParts = parseGitHubRepositoryFullName(options.workflowRepositoryFullName);

  if (resourceParts === null || workflowParts === null) {
    throw new TypeError("invalid GitHub repository full_name");
  }

  const [resourceOwner, resourceRepository] = resourceParts;

  return {
    permissions: options.permissions,
    resource: githubRepositoryResourceConstraint(resourceOwner, resourceRepository),
    subjectToken: oidcSubjectTokenConstraint(
      githubActionsOidcProviderRegistration.issuer,
      claimEquals("repository", options.workflowRepositoryFullName),
      claimOneOf("event_name", options.eventNames),
      claimEquals("ref_type", "branch"),
      claimEquals("ref", mainBranchGitRef),
      claimEquals(
        "workflow_ref",
        `${options.workflowRepositoryFullName}/.github/workflows/${options.workflowFileName}@${mainBranchGitRef}`,
      ),
    ),
  };
}

export function parseGitHubRepositoryFullName(
  fullName: string,
): readonly [owner: string, repository: string] | null {
  const parts = fullName.split("/");

  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    return null;
  }

  try {
    const resource = createGitHubRepositoryResource({
      owner: parts[0],
      repository: parts[1],
    });

    return [resource.owner, resource.repository];
  } catch {
    return null;
  }
}
