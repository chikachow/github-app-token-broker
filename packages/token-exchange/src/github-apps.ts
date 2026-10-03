import type { GitHubAppConfiguration } from "@github-app-token-broker/github/app";
import { parseSubjectTokenAudience } from "@github-app-token-broker/oidc/subject-token-audience";

export interface TokenExchangeGitHubApp extends GitHubAppConfiguration {
  readonly slug: string;
  readonly subjectTokenAudiences: readonly string[];
}

export function snapshotGitHubApps(
  apps: readonly TokenExchangeGitHubApp[],
): readonly TokenExchangeGitHubApp[] {
  if (!Array.isArray(apps)) {
    throw new TypeError("GitHub Apps must be an array");
  }
  const slugs = new Set<string>();
  const clientIds = new Set<string>();
  return Object.freeze(
    Array.from(apps, (app) => {
      if (
        typeof app !== "object" ||
        app === null ||
        typeof app.slug !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(app.slug) ||
        typeof app.clientId !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(app.clientId)
      ) {
        throw new TypeError("Invalid GitHub App identity");
      }
      if (slugs.has(app.slug) || clientIds.has(app.clientId)) {
        throw new TypeError("GitHub App slugs and client IDs must be unique");
      }
      slugs.add(app.slug);
      clientIds.add(app.clientId);
      if (!Array.isArray(app.subjectTokenAudiences) || app.subjectTokenAudiences.length === 0) {
        throw new TypeError("GitHub App Subject-Token Audiences must not be empty");
      }
      const audiences = Object.freeze(
        Array.from(app.subjectTokenAudiences, parseSubjectTokenAudience),
      );
      if (new Set(audiences).size !== audiences.length) {
        throw new TypeError("GitHub App Subject-Token Audiences must be unique");
      }
      return Object.freeze({
        clientId: app.clientId,
        privateKey: app.privateKey,
        slug: app.slug,
        subjectTokenAudiences: audiences,
      });
    }),
  );
}
