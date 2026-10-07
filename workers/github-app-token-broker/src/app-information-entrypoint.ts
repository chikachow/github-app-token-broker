import { GitHubAppConfigurationError } from "@github-app-token-broker/github/app";
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
  githubAppConfigurationFromWorkerBinding,
  snapshotGitHubAppWorkerConfigurations,
  type GitHubAppWorkerConfiguration,
} from "./github-app-bindings.ts";

export function createGitHubAppInformationEntrypoint(
  apps: readonly GitHubAppWorkerConfiguration[],
): {
  new (
    ctx: ExecutionContext<unknown>,
    env: object,
  ): WorkerEntrypoint<object, unknown> & GitHubAppInformation;
} {
  const catalogue = snapshotGitHubAppWorkerConfigurations(apps);
  return class GitHubAppInformationEntrypoint
    extends WorkerEntrypoint<object, unknown>
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
      const props: unknown = this.ctx.props;
      if (
        typeof props !== "object" ||
        props === null ||
        Object.keys(props).length !== 1 ||
        !Object.hasOwn(props, "githubAppClientId") ||
        !("githubAppClientId" in props) ||
        typeof props.githubAppClientId !== "string"
      ) {
        throw new GitHubAppConfigurationError();
      }
      const app = catalogue.find((candidate) => candidate.clientId === props.githubAppClientId);
      if (app === undefined) {
        throw new GitHubAppConfigurationError();
      }
      const binding: unknown = Reflect.get(this.env, app.privateKeyBinding);
      return createGitHubAppInformation(githubAppConfigurationFromWorkerBinding(app, binding));
    }
  };
}
