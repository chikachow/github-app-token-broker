import { importPKCS8, SignJWT, type CryptoKey } from "jose";
import * as z from "zod";

import {
  defaultGitHubApiDependencies,
  fetchGitHubApiJson,
  githubAcceptHeader,
  githubApiVersion,
  type GitHubApiDependencies,
} from "./http.ts";
import { resolveSecretText, type SecretTextBinding } from "./secrets.ts";

const githubJwtLifetimeSeconds = 9 * 60;

let cachedPrivateKey:
  | {
      readonly fingerprint: string;
      readonly imported: Promise<CryptoKey>;
    }
  | undefined;

export interface ResolvedGitHubAppInstallation {
  id: number;
}

export interface InstallationAccessToken {
  expiresAt: string;
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

export interface GitHubAppEnv {
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_PRIVATE_KEY: SecretTextBinding;
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

export async function resolveInstallationForRepository(
  env: GitHubAppEnv,
  repository: string,
  dependencies: GitHubAppDependencies = defaultGitHubAppDependencies,
): Promise<ResolvedGitHubAppInstallation> {
  const body = await fetchGitHubApiJson(dependencies, {
    headers: await githubAppAuthenticationHeaders(env, dependencies),
    path: `/repos/${repository}/installation`,
    responseSchema: githubInstallationResponseSchema.refine((installation) =>
      githubRepositoryOwnerMatches(repository, installation.account.login),
    ),
  });

  return { id: body.id };
}

function githubRepositoryOwnerMatches(repository: string, installationOwner: string): boolean {
  const separator = repository.indexOf("/");

  if (separator <= 0) {
    return false;
  }

  const repositoryOwner = repository.slice(0, separator);

  return repositoryOwner.toLowerCase() === installationOwner.toLowerCase();
}

export async function createInstallationAccessTokenForRepositoryName(
  env: GitHubAppEnv,
  installationId: number,
  repositoryName: string,
  permissions: Record<string, string>,
  dependencies: GitHubAppDependencies = defaultGitHubAppDependencies,
): Promise<InstallationAccessToken> {
  const requestBody = {
    permissions,
    repositories: [repositoryName],
  };

  const responseBody = await fetchGitHubApiJson(dependencies, {
    headers: await githubAppAuthenticationHeaders(env, dependencies),
    init: {
      body: JSON.stringify(requestBody),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    },
    path: `/app/installations/${installationId}/access_tokens`,
    responseSchema: githubInstallationAccessTokenResponseSchema,
  });

  return {
    expiresAt: responseBody.expires_at,
    permissions: responseBody.permissions,
    token: responseBody.token,
  };
}

export async function githubAppAuthenticationHeaders(
  env: GitHubAppEnv,
  dependencies: GitHubAppDependencies,
): Promise<HeadersInit> {
  assertValidGitHubAppConfiguration(env);
  const jwt = await createGitHubAppJwt(env, () => dependencies.now());

  return {
    accept: githubAcceptHeader,
    authorization: `Bearer ${jwt}`,
    "user-agent": "github-app-token-broker",
    "x-github-api-version": githubApiVersion,
  };
}

function assertValidGitHubAppConfiguration(env: GitHubAppEnv): void {
  if (!/^[1-9][0-9]*$/u.test(env.GITHUB_APP_ID)) {
    throw new GitHubAppConfigurationError();
  }
}

async function createGitHubAppJwt(env: GitHubAppEnv, now: () => Date): Promise<string> {
  const privateKey = await importedGitHubAppPrivateKey(await githubAppPrivateKeyPem(env));
  const nowSeconds = Math.floor(now().getTime() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(nowSeconds - 60)
    .setExpirationTime(nowSeconds + githubJwtLifetimeSeconds)
    .setIssuer(env.GITHUB_APP_ID)
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

async function githubAppPrivateKeyPem(env: GitHubAppEnv): Promise<string> {
  const privateKeyPem = await resolveSecretText(env.GITHUB_APP_PRIVATE_KEY);

  if (privateKeyPem !== undefined && privateKeyPem.length > 0) {
    return privateKeyPem;
  }

  throw new GitHubAppConfigurationError();
}

async function privateKeyFingerprint(privateKeyPem: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(privateKeyPem));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
