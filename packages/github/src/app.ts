import { importPKCS8, SignJWT, type CryptoKey } from "jose";
import * as z from "zod";

import {
  defaultGitHubApiDependencies,
  fetchGitHubApiJson,
  GitHubApiError,
  GitHubApiTransportError,
  githubAcceptHeader,
  githubApiVersion,
  revokeGitHubInstallationAccessToken,
  type GitHubApiDependencies,
} from "./http.ts";
import type { InstallationAccessTokenRequest } from "./installation-access-token-request.ts";
import { resolveSecretText, type SecretTextBinding } from "./secrets.ts";

const githubJwtLifetimeSeconds = 9 * 60;

let cachedPrivateKey:
  | {
      readonly fingerprint: string;
      readonly imported: Promise<CryptoKey>;
    }
  | undefined;

export type GitHubInstallationAccessTokenIssuanceFailureReason =
  | "internal_failure"
  | "upstream_failure"
  | "upstream_unavailable";

type GitHubInstallationAccessTokenIssuanceResult =
  | {
      readonly expiresAt: string;
      readonly installationId: number;
      readonly ok: true;
      readonly permissions: Readonly<Record<string, string>>;
      readonly token: string;
      revoke(): Promise<void>;
    }
  | {
      readonly error: {
        readonly message: string;
        readonly name:
          | "Error"
          | "GitHubApiError"
          | "GitHubApiTransportError"
          | "GitHubAppConfigurationError";
        readonly status: number | undefined;
        readonly upstreamStatus: number | undefined;
      };
      readonly installationId: number | undefined;
      readonly ok: false;
      readonly reason: GitHubInstallationAccessTokenIssuanceFailureReason;
    };

export class GitHubAppConfigurationError extends Error {
  public constructor() {
    super("invalid GitHub App configuration");
  }
}

Object.defineProperty(GitHubAppConfigurationError.prototype, "name", {
  value: "GitHubAppConfigurationError",
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

export async function issueInstallationAccessToken(
  configuration: GitHubAppConfiguration,
  request: InstallationAccessTokenRequest,
  dependencies: GitHubAppDependencies = defaultGitHubAppDependencies,
): Promise<GitHubInstallationAccessTokenIssuanceResult> {
  let installationId: number | undefined;

  try {
    const authenticationHeaders = await githubAppAuthenticationHeaders(configuration, dependencies);
    const repositoryPath = `${request.resource.owner}/${request.resource.repository}`;
    const installation = await fetchGitHubApiJson(dependencies, {
      headers: authenticationHeaders,
      path: `/repos/${repositoryPath}/installation`,
      responseSchema: githubInstallationResponseSchema.refine((resolvedInstallation) =>
        githubRepositoryOwnerMatches(request.resource.owner, resolvedInstallation.account.login),
      ),
    });
    installationId = installation.id;
    const responseBody = await fetchGitHubApiJson(dependencies, {
      headers: authenticationHeaders,
      init: {
        body: JSON.stringify({
          permissions: request.permissions,
          repositories: [request.resource.repository],
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      },
      path: `/app/installations/${installation.id}/access_tokens`,
      responseSchema: githubInstallationAccessTokenResponseSchema,
    });

    return {
      expiresAt: responseBody.expires_at,
      installationId: installation.id,
      ok: true,
      permissions: responseBody.permissions,
      revoke: () => revokeGitHubInstallationAccessToken(dependencies, responseBody.token),
      token: responseBody.token,
    };
  } catch (error) {
    return {
      error: installationAccessTokenIssuanceErrorFields(error),
      installationId,
      ok: false,
      reason: installationAccessTokenIssuanceFailureReason(error),
    };
  }
}

function installationAccessTokenIssuanceFailureReason(
  error: unknown,
): GitHubInstallationAccessTokenIssuanceFailureReason {
  if (error instanceof GitHubApiTransportError) {
    return "upstream_unavailable";
  }

  if (error instanceof GitHubApiError) {
    if (error.rateLimited || error.status === 503) {
      return "upstream_unavailable";
    }

    if (error.status === 400 || error.status === 401 || error.status === 422) {
      return "internal_failure";
    }

    if (error.status === 403 || error.status === 404 || error.status >= 500) {
      return "upstream_failure";
    }
  }

  return "internal_failure";
}

function installationAccessTokenIssuanceErrorFields(
  error: unknown,
): Extract<GitHubInstallationAccessTokenIssuanceResult, { ok: false }>["error"] {
  if (error instanceof GitHubApiError) {
    return {
      message: error.message,
      name: "GitHubApiError",
      status: error.status,
      upstreamStatus: error.upstreamStatus,
    };
  }

  if (error instanceof GitHubApiTransportError) {
    return {
      message: error.message,
      name: "GitHubApiTransportError",
      status: undefined,
      upstreamStatus: undefined,
    };
  }

  if (error instanceof GitHubAppConfigurationError) {
    return {
      message: error.message,
      name: "GitHubAppConfigurationError",
      status: undefined,
      upstreamStatus: undefined,
    };
  }

  return {
    message: "unexpected Installation Access Token Issuance error",
    name: "Error",
    status: undefined,
    upstreamStatus: undefined,
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
