import { importPKCS8, SignJWT } from "jose";
import * as z from "zod";
import { awaitWithAbortSignal } from "@github-app-token-broker/http/abort";

import {
  defaultGitHubApiDependencies,
  fetchGitHubApiJson,
  fetchGitHubApiJsonResponse,
  GitHubApiError,
  GitHubApiTransportError,
  githubAcceptHeader,
  githubApiVersion,
  revokeGitHubInstallationAccessToken,
  type GitHubApiDependencies,
} from "./http.ts";
import type { InstallationAccessTokenRequest } from "./installation-access-token-request.ts";
import { resolveSecretText, type SecretTextBinding } from "./secrets.ts";

const githubAppJwtExpirationOffsetSeconds = 9 * 60;

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
      readonly revocationOutcome?: "succeeded" | "failed";
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
  readonly clientId: string;
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
  permissions: z.unknown(),
  repositories: z
    .array(z.object({ name: z.string().min(1), owner: z.object({ login: z.string().min(1) }) }))
    .optional(),
  token: z.string().min(1),
});
const githubInstallationAccessTokenValueSchema = z.object({ token: z.string().min(1) });

export async function issueInstallationAccessToken(
  configuration: GitHubAppConfiguration,
  request: InstallationAccessTokenRequest,
  dependencies: GitHubAppDependencies = defaultGitHubAppDependencies,
  signal?: AbortSignal,
): Promise<GitHubInstallationAccessTokenIssuanceResult> {
  let installationId: number | undefined;
  let recoveredToken: string | undefined;

  try {
    signal?.throwIfAborted();
    const authentication = githubAppAuthenticationHeaders(configuration, dependencies);
    const authenticationHeaders = await (signal === undefined
      ? authentication
      : awaitWithAbortSignal(authentication, signal));
    signal?.throwIfAborted();
    const repositoryPath = `${request.resource.owner}/${request.resource.repository}`;
    const installation = await fetchGitHubApiJson(dependencies, {
      headers: authenticationHeaders,
      ...(signal === undefined ? {} : { init: { signal } }),
      path: `/repos/${repositoryPath}/installation`,
      responseSchema: githubInstallationResponseSchema.refine((resolvedInstallation) =>
        githubRepositoryOwnerMatches(request.resource.owner, resolvedInstallation.account.login),
      ),
    });
    installationId = installation.id;
    signal?.throwIfAborted();
    // An accepted mint remains owned through its fixed transport deadline, even after cancellation.
    const tokenPath = `/app/installations/${installation.id}/access_tokens`;
    const response = await fetchGitHubApiJsonResponse(dependencies, {
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
      path: tokenPath,
    });
    // Own a decoded credential until a successful result transfers it to the caller.
    const recovered = githubInstallationAccessTokenValueSchema.safeParse(response.body);
    if (recovered.success) recoveredToken = recovered.data.token;
    const parsed = githubInstallationAccessTokenResponseSchema.safeParse(response.body);

    if (
      !parsed.success ||
      !permissionsMatch(parsed.data.permissions, request.permissions) ||
      !(Date.parse(parsed.data.expires_at) - dependencies.now().getTime() >= 1000) ||
      (parsed.data.repositories !== undefined &&
        (parsed.data.repositories.length !== 1 ||
          parsed.data.repositories[0]!.name.toLowerCase() !==
            request.resource.repository.toLowerCase() ||
          !githubRepositoryOwnerMatches(
            request.resource.owner,
            parsed.data.repositories[0]!.owner.login,
          )))
    ) {
      throw new GitHubApiError(
        502,
        `GitHub API returned an invalid response: ${tokenPath}`,
        false,
        response.status,
      );
    }

    return {
      expiresAt: parsed.data.expires_at,
      installationId: installation.id,
      ok: true,
      permissions: parsed.data.permissions,
      revoke: () => revokeGitHubInstallationAccessToken(dependencies, parsed.data.token),
      token: parsed.data.token,
    };
  } catch (error) {
    let revocationOutcome: "succeeded" | "failed" | undefined;
    if (recoveredToken !== undefined) {
      try {
        await revokeGitHubInstallationAccessToken(dependencies, recoveredToken);
        revocationOutcome = "succeeded";
      } catch {
        revocationOutcome = "failed";
      }
    }
    return {
      error: installationAccessTokenIssuanceErrorFields(error),
      installationId,
      ok: false,
      reason: installationAccessTokenIssuanceFailureReason(error),
      ...(revocationOutcome === undefined ? {} : { revocationOutcome }),
    };
  }
}

function permissionsMatch(
  permissions: unknown,
  requested: Readonly<Record<string, string>>,
): permissions is Readonly<Record<string, string>> {
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return false;
  }
  const entries = Object.entries(permissions);
  return (
    entries.length === Object.keys(requested).length &&
    entries.every(([name, level]) => Object.hasOwn(requested, name) && level === requested[name])
  );
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
      upstreamStatus: error.upstreamStatus,
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
  const { clientId, privateKey } = configuration;
  if (!isGitHubAppClientId(clientId)) {
    throw new GitHubAppConfigurationError();
  }
  const jwt = await createGitHubAppJwt(clientId, privateKey, () => dependencies.now());

  return {
    accept: githubAcceptHeader,
    authorization: `Bearer ${jwt}`,
    "user-agent": "github-app-token-broker",
    "x-github-api-version": githubApiVersion,
  };
}

export function isGitHubAppClientId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(value);
}

async function createGitHubAppJwt(
  clientId: string,
  privateKeyBinding: SecretTextBinding,
  now: () => Date,
): Promise<string> {
  const privateKeyPem = await githubAppPrivateKeyPem(privateKeyBinding);
  const privateKey = await importPKCS8(privateKeyPem, "RS256").catch(() => {
    throw new GitHubAppConfigurationError();
  });
  const nowSeconds = Math.floor(now().getTime() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(nowSeconds - 60)
    .setExpirationTime(nowSeconds + githubAppJwtExpirationOffsetSeconds)
    .setIssuer(clientId)
    .sign(privateKey);
}

async function githubAppPrivateKeyPem(binding: SecretTextBinding): Promise<string> {
  if (
    typeof binding !== "string" &&
    (typeof binding !== "object" || binding === null || typeof binding.get !== "function")
  ) {
    throw new GitHubAppConfigurationError();
  }

  const privateKeyPem: unknown = await resolveSecretText(binding);

  if (typeof privateKeyPem === "string" && privateKeyPem.length > 0) {
    return privateKeyPem;
  }

  throw new GitHubAppConfigurationError();
}
