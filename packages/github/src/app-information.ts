import * as z from "zod";

import {
  defaultGitHubAppDependencies,
  githubAppAuthenticationHeaders,
  GitHubAppConfigurationError,
  type GitHubAppEnv,
  type GitHubAppDependencies,
} from "./app.ts";
import { fetchGitHubApiJson, GitHubApiError, GitHubApiTransportError } from "./http.ts";
import { isGitHubRepositoryResourcePathSegment } from "./installation-access-token-request.ts";

const maxGitHubInstallationsPageBytes = 1024 * 1024;

const githubUserAccountSchema = z.looseObject({
  avatar_url: z.string().min(1),
  events_url: z.string().min(1),
  followers_url: z.string().min(1),
  following_url: z.string().min(1),
  gists_url: z.string().min(1),
  gravatar_id: z.string().nullable(),
  html_url: z.string().min(1),
  id: z.int().positive(),
  login: z.string().min(1),
  node_id: z.string().min(1),
  organizations_url: z.string().min(1),
  received_events_url: z.string().min(1),
  repos_url: z.string().min(1),
  site_admin: z.boolean(),
  starred_url: z.string().min(1),
  subscriptions_url: z.string().min(1),
  type: z.string().min(1),
  url: z.string().min(1),
  email: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  starred_at: z.string().optional(),
  user_view_type: z.string().optional(),
});

const githubEnterpriseAccountSchema = z.looseObject({
  avatar_url: z.string().min(1),
  created_at: z.iso.datetime({ offset: true }).nullable(),
  html_url: z.string().min(1),
  id: z.int().positive(),
  name: z.string().min(1),
  node_id: z.string().min(1),
  slug: z.string().min(1),
  updated_at: z.iso.datetime({ offset: true }).nullable(),
  description: z.string().nullable().optional(),
  website_url: z.string().nullable().optional(),
});

const githubAccountSchema = z.union([githubUserAccountSchema, githubEnterpriseAccountSchema]);

const githubAppSchema = z.looseObject({
  id: z.int().positive(),
  slug: z.string().min(1).optional(),
  client_id: z.string().min(1).optional(),
  node_id: z.string().min(1),
  owner: githubAccountSchema,
  name: z.string().min(1),
  description: z.string().nullable(),
  external_url: z.string().min(1),
  html_url: z.string().min(1),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
  installations_count: z.int().nonnegative().optional(),
  permissions: z.record(z.string(), z.string()),
  events: z.array(z.string()),
});

const githubInstallationSchema = z.looseObject({
  id: z.int().positive(),
  account: githubAccountSchema.nullable(),
  access_tokens_url: z.string().min(1),
  repositories_url: z.string().min(1),
  html_url: z.string().min(1),
  app_id: z.int().positive(),
  client_id: z.string().min(1).optional(),
  target_id: z.int().positive(),
  target_type: z.string().min(1),
  permissions: z.record(z.string(), z.string()),
  events: z.array(z.string()),
  single_file_name: z.string().nullable(),
  has_multiple_single_files: z.boolean().optional(),
  single_file_paths: z.array(z.string()).optional(),
  repository_selection: z.string().min(1),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
  app_slug: z.string().min(1),
  suspended_at: z.iso.datetime({ offset: true }).nullable(),
  suspended_by: githubUserAccountSchema.nullable(),
  contact_email: z.string().nullable().optional(),
});

const listInstallationsInputSchema = z.strictObject({
  page: z.int().positive().optional(),
  per_page: z.int().min(1).max(100).optional(),
  since: z.string().optional(),
  outdated: z.string().optional(),
});

const installationInputSchema = z.strictObject({
  installation_id: z.int().positive(),
});

const githubPathSegmentSchema = z
  .string()
  .min(1)
  .refine(isGitHubRepositoryResourcePathSegment, "must be a GitHub repository path segment");

const repositoryInstallationInputSchema = z.strictObject({
  owner: githubPathSegmentSchema,
  repo: githubPathSegmentSchema.refine(
    (value) => !value.toLowerCase().endsWith(".git"),
    "must not include the .git suffix",
  ),
});

export type GitHubApp = z.output<typeof githubAppSchema>;
export type GitHubAppInstallation = z.output<typeof githubInstallationSchema>;
export type GitHubAppListInstallationsInput = z.input<typeof listInstallationsInputSchema>;
export type GitHubAppInstallationInput = z.input<typeof installationInputSchema>;
export type GitHubAppRepositoryInstallationInput = z.input<
  typeof repositoryInstallationInputSchema
>;

export class GitHubAppNotFoundError extends Error {
  public constructor() {
    super("GitHub App information was not found");
  }
}

Object.defineProperty(GitHubAppNotFoundError.prototype, "name", {
  value: "GitHubAppNotFoundError",
});

export class GitHubAppUnavailableError extends Error {
  public constructor() {
    super("GitHub App information is temporarily unavailable");
  }
}

Object.defineProperty(GitHubAppUnavailableError.prototype, "name", {
  value: "GitHubAppUnavailableError",
});

export class GitHubAppUpstreamError extends Error {
  public constructor() {
    super("GitHub App information request failed upstream");
  }
}

Object.defineProperty(GitHubAppUpstreamError.prototype, "name", {
  value: "GitHubAppUpstreamError",
});

export class GitHubAppInputError extends Error {
  public constructor() {
    super("invalid GitHub App information request");
  }
}

Object.defineProperty(GitHubAppInputError.prototype, "name", {
  value: "GitHubAppInputError",
});

export class GitHubAppInternalError extends Error {
  public constructor() {
    super("GitHub App information request failed internally");
  }
}

Object.defineProperty(GitHubAppInternalError.prototype, "name", {
  value: "GitHubAppInternalError",
});

export interface GitHubAppInformation {
  getApp(): Promise<GitHubApp>;
  listInstallations(input?: GitHubAppListInstallationsInput): Promise<GitHubAppInstallation[]>;
  getInstallation(input: GitHubAppInstallationInput): Promise<GitHubAppInstallation>;
  getRepositoryInstallation(
    input: GitHubAppRepositoryInstallationInput,
  ): Promise<GitHubAppInstallation>;
}

export function createGitHubAppInformation(
  configuration: GitHubAppEnv,
  dependencies: GitHubAppDependencies = defaultGitHubAppDependencies,
): GitHubAppInformation {
  return {
    getApp: async () =>
      requestGitHubAppInformation(configuration, dependencies, {
        path: "/app",
        responseSchema: githubAppSchema,
      }),

    listInstallations: async (input = {}) => {
      const parsedInput = parseInput(listInstallationsInputSchema, input);

      return requestGitHubAppInformation(configuration, dependencies, {
        maxResponseBodyBytes: maxGitHubInstallationsPageBytes,
        path: listInstallationsPath(parsedInput),
        responseSchema: z.array(githubInstallationSchema),
      });
    },

    getInstallation: async (input) => {
      const parsedInput = parseInput(installationInputSchema, input);

      return requestGitHubAppInformation(configuration, dependencies, {
        notFound: true,
        path: `/app/installations/${parsedInput.installation_id}`,
        responseSchema: githubInstallationSchema,
      });
    },

    getRepositoryInstallation: async (input) => {
      const parsedInput = parseInput(repositoryInstallationInputSchema, input);

      return requestGitHubAppInformation(configuration, dependencies, {
        notFound: true,
        path: `/repos/${encodeURIComponent(parsedInput.owner)}/${encodeURIComponent(parsedInput.repo)}/installation`,
        responseSchema: githubInstallationSchema,
      });
    },
  };
}

async function requestGitHubAppInformation<Schema extends z.ZodType>(
  configuration: GitHubAppEnv,
  dependencies: GitHubAppDependencies,
  {
    notFound = false,
    maxResponseBodyBytes,
    path,
    responseSchema,
  }: {
    notFound?: boolean;
    maxResponseBodyBytes?: number;
    path: string;
    responseSchema: Schema;
  },
): Promise<z.output<Schema>> {
  try {
    return await fetchGitHubApiJson(dependencies, {
      headers: await githubAppAuthenticationHeaders(configuration, dependencies),
      ...(maxResponseBodyBytes === undefined ? {} : { maxResponseBodyBytes }),
      path,
      responseSchema,
    });
  } catch (error) {
    throw normalizeGitHubAppInformationError(error, notFound);
  }
}

function normalizeGitHubAppInformationError(error: unknown, notFound: boolean): Error {
  if (error instanceof GitHubAppConfigurationError) {
    return error;
  }

  if (error instanceof GitHubApiTransportError) {
    return new GitHubAppUnavailableError();
  }

  if (error instanceof GitHubApiError) {
    if (error.upstreamStatus === 401) {
      return new GitHubAppConfigurationError();
    }

    if (notFound && error.upstreamStatus === 404) {
      return new GitHubAppNotFoundError();
    }

    if (error.rateLimited || error.upstreamStatus === 429 || error.upstreamStatus === 503) {
      return new GitHubAppUnavailableError();
    }

    return new GitHubAppUpstreamError();
  }

  return new GitHubAppInternalError();
}

function listInstallationsPath(input: GitHubAppListInstallationsInput): string {
  const query = new URLSearchParams();

  if (input.page !== undefined) {
    query.set("page", String(input.page));
  }
  if (input.per_page !== undefined) {
    query.set("per_page", String(input.per_page));
  }
  if (input.since !== undefined) {
    query.set("since", input.since);
  }
  if (input.outdated !== undefined) {
    query.set("outdated", input.outdated);
  }

  const queryString = query.toString();

  return queryString.length === 0 ? "/app/installations" : `/app/installations?${queryString}`;
}

function parseInput<Schema extends z.ZodType>(schema: Schema, input: unknown): z.output<Schema> {
  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    throw new GitHubAppInputError();
  }

  return parsed.data;
}
