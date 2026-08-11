import { readBodyUpTo } from "@github-app-token-broker/http/body";
import * as z from "zod";

export const githubAcceptHeader = "application/vnd.github+json";
export const githubApiVersion = "2022-11-28";
const maxGitHubErrorBodyBytes = 16 * 1024;
// Installation resolution and token responses are small, fixed-shape documents.
// Keep a shared cap so a successful upstream response cannot allocate unbounded memory.
const maxGitHubSuccessfulBodyBytes = 64 * 1024;
const githubErrorResponseSchema = z.object({ message: z.string() });

export interface GitHubApiEnv {
  GITHUB_API_BASE_URL?: string;
}

export interface GitHubApiDependencies {
  fetch: typeof fetch;
}

export const defaultGitHubApiDependencies: GitHubApiDependencies = {
  fetch: (input, init) => fetch(input, init),
};

export class GitHubApiError extends Error {
  public readonly rateLimited: boolean;
  public readonly status: number;
  public readonly upstreamStatus: number;

  public constructor(
    status: number,
    message: string,
    rateLimited = false,
    upstreamStatus = status,
  ) {
    super(message);
    this.rateLimited = rateLimited;
    this.status = status;
    this.upstreamStatus = upstreamStatus;
  }
}

export class GitHubApiTransportError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitHubApiTransportError";
  }
}

export async function fetchGitHubApiJson<Schema extends z.ZodType>(
  env: GitHubApiEnv,
  dependencies: GitHubApiDependencies,
  {
    headers,
    init,
    path,
    responseSchema,
  }: {
    headers: HeadersInit;
    init?: RequestInit;
    path: string;
    responseSchema: Schema;
  },
): Promise<z.output<Schema>> {
  const requestHeaders = new Headers(headers);

  for (const [name, value] of new Headers(init?.headers)) {
    requestHeaders.set(name, value);
  }

  const baseUrl = env.GITHUB_API_BASE_URL ?? "https://api.github.com";
  const requestUrl = new URL(path.replace(/^\//u, ""), ensureTrailingSlash(baseUrl));

  let response: Response;

  try {
    response = await dependencies.fetch(requestUrl, {
      ...init,
      headers: requestHeaders,
    });
  } catch {
    throw new GitHubApiTransportError(`GitHub API request failed: ${path}`);
  }

  if (!response.ok) {
    throw new GitHubApiError(
      response.status,
      `GitHub API request failed: ${path}`,
      await githubResponseIsRateLimited(response),
    );
  }

  let bodyRead: Awaited<ReturnType<typeof readBodyUpTo>>;

  try {
    bodyRead = await readBodyUpTo(response.body, maxGitHubSuccessfulBodyBytes);
  } catch {
    throw new GitHubApiTransportError(`GitHub API request failed: ${path}`);
  }

  if (!bodyRead.ok) {
    throw invalidGitHubApiResponse(path, response.status);
  }

  const responseText = new TextDecoder().decode(bodyRead.bytes);

  let responseBody: unknown;

  try {
    responseBody = JSON.parse(responseText);
  } catch {
    throw invalidGitHubApiResponse(path, response.status);
  }

  const parsed = responseSchema.safeParse(responseBody);

  if (!parsed.success) {
    throw invalidGitHubApiResponse(path, response.status);
  }

  return parsed.data;
}

async function githubResponseIsRateLimited(response: Response): Promise<boolean> {
  if (response.status === 429) {
    return true;
  }

  if (response.status !== 403) {
    return false;
  }

  if (
    response.headers.get("x-ratelimit-remaining") === "0" ||
    response.headers.has("retry-after")
  ) {
    return true;
  }

  let bodyRead: Awaited<ReturnType<typeof readBodyUpTo>>;

  try {
    bodyRead = await readBodyUpTo(response.body, maxGitHubErrorBodyBytes);
  } catch {
    return false;
  }

  if (!bodyRead.ok) {
    return false;
  }

  const body = new TextDecoder().decode(bodyRead.bytes);

  try {
    const parsed: unknown = JSON.parse(body);
    const errorResponse = githubErrorResponseSchema.safeParse(parsed);

    return errorResponse.success && /\brate limit\b/iu.test(errorResponse.data.message);
  } catch {
    return false;
  }
}

function invalidGitHubApiResponse(path: string, upstreamStatus: number): GitHubApiError {
  return new GitHubApiError(
    502,
    `GitHub API returned an invalid response: ${path}`,
    false,
    upstreamStatus,
  );
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}
