import { WorkerEntrypoint } from "cloudflare:workers";
import {
  createGitHubAppInformation,
  type GitHubApp,
  type GitHubAppInformation,
  type GitHubAppInstallation,
  type GitHubAppInstallationInput,
  type GitHubAppListInstallationsInput,
  type GitHubAppRepositoryInstallationInput,
} from "@github-app-token-broker/github/app-information";
import {
  githubAppConfigurationFromWorkerBindings,
  type GitHubAppWorkerBindings,
} from "./github-app-bindings.ts";

export class GitHubAppInformationEntrypoint
  extends WorkerEntrypoint<GitHubAppWorkerBindings>
  implements GitHubAppInformation
{
  async getApp(): Promise<GitHubApp> {
    return this.#information().getApp();
  }

  async listInstallations(
    input?: GitHubAppListInstallationsInput,
  ): Promise<GitHubAppInstallation[]> {
    return this.#information().listInstallations(input);
  }

  async getInstallation(input: GitHubAppInstallationInput): Promise<GitHubAppInstallation> {
    return this.#information().getInstallation(input);
  }

  async getRepositoryInstallation(
    input: GitHubAppRepositoryInstallationInput,
  ): Promise<GitHubAppInstallation> {
    return this.#information().getRepositoryInstallation(input);
  }

  #information(): GitHubAppInformation {
    return createGitHubAppInformation(githubAppConfigurationFromWorkerBindings(this.env));
  }
}
