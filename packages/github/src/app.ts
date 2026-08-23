import { importPKCS8, SignJWT, type CryptoKey } from "jose";
import * as z from "zod";

import {
  defaultGitHubApiDependencies,
  fetchGitHubApiJson,
  githubAcceptHeader,
  githubApiVersion,
  type GitHubApiDependencies,
} from "./http.ts";
import type {
  GitHubInstallationPermissions,
  GitHubRepositoryResource,
} from "./installation-access-token-request.ts";
import { resolveSecretText, type SecretTextBinding } from "./secrets.ts";

const githubJwtLifetimeSeconds = 9 * 60;

let cachedPrivateKey:
  | {
      readonly fingerprint: string;
      readonly imported: Promise<CryptoKey>;
    }
  | undefined;

export interface InstallationAccessToken {
  expiresAt: string;
  installationId: number;
  permissions: Record<string, string>;
  token: string;
}

export class GitHubAppConfigurationError extends Error {
  public constructor() {
    super("invalid GitHub App configuration");
  }
}

Object.defineProperty(GitHubAppConfigurationError.prototype, "name", {
  value: "GitHubAppConfigurationError",
});

export class GitHubInstallationAccessTokenIssuanceError extends Error {
  public readonly installationId: number;

  public constructor(installationId: number, cause: unknown) {
    super("GitHub Installation Access Token Issuance failed", { cause });
    this.installationId = installationId;
  }
}

Object.defineProperty(GitHubInstallationAccessTokenIssuanceError.prototype, "name", {
  value: "GitHubInstallationAccessTokenIssuanceError",
});

export interface GitHubAppConfiguration {
  readonly appId: string;
  readonly privateKey: SecretTextBinding;
}

export interface GitHubAppDependencies extends GitHubApiDependencies {
  now(): Date;
}

export const defaultGitHubAppDependencies: GitHubAppDependencies = {
  ...defaultGitHubApiDependencies,
  now: () => new Date(),
};

const githubInstallationResponseSchema = z.object({
  account: z.object({ login: z.string().min(1) }),
  id: z.int().positive(),
});

const githubInstallationAccessTokenResponseSchema = z.object({
  expires_at: z.iso.datetime({ offset: true }),
  permissions: z.record(z.string(), z.string()),
  token: z.string().min(1),
});

export async function issueInstallationAccessTokenForRepository(
  configuration: GitHubAppConfiguration,
  resource: GitHubRepositoryResource,
  permissions: GitHubInstallationPermissions,
  dependencies: GitHubAppDependencies = defaultGitHubAppDependencies,
): Promise<InstallationAccessToken> {
  const authenticationHeaders = await githubAppAuthenticationHeaders(configuration, dependencies);
  const repositoryPath = `${resource.owner}/${resource.repository}`;
  const installation = await fetchGitHubApiJson(dependencies, {
    headers: authenticationHeaders,
    path: `/repos/${repositoryPath}/installation`,
    responseSchema: githubInstallationResponseSchema.refine((installation) =>
      githubRepositoryOwnerMatches(resource.owner, installation.account.login),
    ),
  });
  const requestBody = {
    permissions,
    repositories: [resource.repository],
  };
  let responseBody: z.output<typeof githubInstallationAccessTokenResponseSchema>;

  try {
    responseBody = await fetchGitHubApiJson(dependencies, {
      headers: authenticationHeaders,
      init: {
        body: JSON.stringify(requestBody),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      },
      path: `/app/installations/${installation.id}/access_tokens`,
      responseSchema: githubInstallationAccessTokenResponseSchema,
    });
  } catch (cause) {
    throw new GitHubInstallationAccessTokenIssuanceError(installation.id, cause);
  }

  return {
    expiresAt: responseBody.expires_at,
    installationId: installation.id,
    permissions: responseBody.permissions,
    token: responseBody.token,
  };
}

function githubRepositoryOwnerMatches(repositoryOwner: string, installationOwner: string): boolean {
  return repositoryOwner.toLowerCase() === installationOwner.toLowerCase();
}

export async function githubAppAuthenticationHeaders(
  configuration: GitHubAppConfiguration,
  dependencies: GitHubAppDependencies,
): Promise<HeadersInit> {
  assertValidGitHubAppConfiguration(configuration);
  const jwt = await createGitHubAppJwt(configuration, () => dependencies.now());

  return {
    accept: githubAcceptHeader,
    authorization: `Bearer ${jwt}`,
    "user-agent": "github-app-token-broker",
    "x-github-api-version": githubApiVersion,
  };
}

function assertValidGitHubAppConfiguration(configuration: GitHubAppConfiguration): void {
  if (!/^[1-9][0-9]*$/u.test(configuration.appId)) {
    throw new GitHubAppConfigurationError();
  }
}

async function createGitHubAppJwt(
  configuration: GitHubAppConfiguration,
  now: () => Date,
): Promise<string> {
  const privateKey = await importedGitHubAppPrivateKey(await githubAppPrivateKeyPem(configuration));
  const nowSeconds = Math.floor(now().getTime() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(nowSeconds - 60)
    .setExpirationTime(nowSeconds + githubJwtLifetimeSeconds)
    .setIssuer(configuration.appId)
    .sign(privateKey);
}

async function importedGitHubAppPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
  const fingerprint = await privateKeyFingerprint(privateKeyPem);
  const cached = cachedPrivateKey;

  if (cached?.fingerprint === fingerprint) {
    return cached.imported;
  }

  const imported = importPKCS8(privateKeyPem, "RS256").catch(() => {
    throw new GitHubAppConfigurationError();
  });
  cachedPrivateKey = { fingerprint, imported };

  return imported;
}

async function githubAppPrivateKeyPem(configuration: GitHubAppConfiguration): Promise<string> {
  const privateKeyPem = await resolveSecretText(configuration.privateKey);

  if (privateKeyPem !== undefined && privateKeyPem.length > 0) {
    return privateKeyPem;
  }

  throw new GitHubAppConfigurationError();
}

async function privateKeyFingerprint(privateKeyPem: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(privateKeyPem));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
