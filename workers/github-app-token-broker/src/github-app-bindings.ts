import type { GitHubAppConfiguration } from "@github-app-token-broker/github/app";
import type { SecretTextBinding } from "@github-app-token-broker/github/secrets";

export interface GitHubAppWorkerBindings {
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_PRIVATE_KEY: SecretTextBinding;
}

export function githubAppConfigurationFromWorkerBindings(
  bindings: GitHubAppWorkerBindings,
): GitHubAppConfiguration {
  return {
    appId: bindings.GITHUB_APP_ID,
    privateKey: bindings.GITHUB_APP_PRIVATE_KEY,
  };
}
