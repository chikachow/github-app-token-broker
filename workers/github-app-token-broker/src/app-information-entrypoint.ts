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
import type { GitHubAppEnv } from "@github-app-token-broker/github/app";

export class GitHubAppInformationEntrypoint
  extends WorkerEntrypoint<GitHubAppEnv>
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
    return createGitHubAppInformation(this.env);
  }
}
