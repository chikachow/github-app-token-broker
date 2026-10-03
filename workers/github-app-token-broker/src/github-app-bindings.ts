import {
  GitHubAppConfigurationError,
  type GitHubAppConfiguration,
} from "@github-app-token-broker/github/app";
import {
  snapshotGitHubApps,
  type TokenExchangeGitHubApp,
} from "@github-app-token-broker/token-exchange";

export interface GitHubAppWorkerConfiguration extends Omit<TokenExchangeGitHubApp, "privateKey"> {
  readonly privateKeyBinding: string;
}

export function snapshotGitHubAppWorkerConfigurations(
  apps: readonly GitHubAppWorkerConfiguration[],
): readonly GitHubAppWorkerConfiguration[] {
  const snapshots = snapshotGitHubApps(apps.map((app) => ({ ...app, privateKey: "" })));
  return Object.freeze(
    snapshots.map((app, index) => {
      const privateKeyBinding = apps[index]?.privateKeyBinding;
      if (typeof privateKeyBinding !== "string" || !/^[A-Z][A-Z0-9_]*$/u.test(privateKeyBinding)) {
        throw new TypeError("Invalid GitHub App private-key binding name");
      }
      return Object.freeze({
        clientId: app.clientId,
        slug: app.slug,
        subjectTokenAudiences: app.subjectTokenAudiences,
        privateKeyBinding,
      });
    }),
  );
}

export function githubAppConfigurationFromWorkerBinding(
  app: GitHubAppWorkerConfiguration,
  binding: unknown,
): GitHubAppConfiguration {
  return Object.freeze({
    clientId: app.clientId,
    privateKey: Object.freeze({
      async get(): Promise<string> {
        if (typeof binding === "string") {
          return binding;
        }
        if (
          typeof binding === "object" &&
          binding !== null &&
          "get" in binding &&
          typeof binding.get === "function"
        ) {
          const value: unknown = await binding.get();
          if (typeof value === "string") {
            return value;
          }
        }
        throw new GitHubAppConfigurationError();
      },
    }),
  });
}
