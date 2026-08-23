import { readBodyUpTo } from "@github-app-token-broker/http/body";
import * as z from "zod";

export const githubAcceptHeader = "application/vnd.github+json";
export const githubApiVersion = "2022-11-28";
const maxGitHubErrorBodyBytes = 16 * 1024;
// Installation resolution and token responses are small, fixed-shape documents.
// Larger bounded endpoints can override this default explicitly.
const maxGitHubSuccessfulBodyBytes = 64 * 1024;
const githubErrorResponseSchema = z.object({ message: z.string() });
const githubApiBaseUrl = new URL("https://api.github.com/");

// The deadline covers response headers and complete body consumption for one
// GitHub request. It is fixed so callers cannot weaken this transport bound.
const githubApiRequestDeadlineMilliseconds = 10_000;

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
  dependencies: GitHubApiDependencies,
  {
    headers,
    init,
    maxResponseBodyBytes = maxGitHubSuccessfulBodyBytes,
    path,
    responseSchema,
  }: {
    headers: HeadersInit;
    init?: RequestInit;
    maxResponseBodyBytes?: number;
    path: string;
    responseSchema: Schema;
  },
): Promise<z.output<Schema>> {
  return requestGitHubApi(dependencies, {
    headers,
    ...(init === undefined ? {} : { init }),
    path,
    readSuccessfulResponse: async (response, requestSignal) => {
      const bodyRead = await readBodyUpTo(response.body, maxResponseBodyBytes, requestSignal);

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
    },
  });
}

export async function revokeGitHubInstallationAccessToken(
  dependencies: GitHubApiDependencies,
  token: string,
): Promise<void> {
  const path = "/installation/token";

  await requestGitHubApi(dependencies, {
    headers: {
      accept: githubAcceptHeader,
      authorization: `Bearer ${token}`,
      "user-agent": "github-app-token-broker",
      "x-github-api-version": githubApiVersion,
    },
    init: { method: "DELETE" },
    path,
    readSuccessfulResponse: (response) => {
      if (response.status !== 204) {
        throw invalidGitHubApiResponse(path, response.status);
      }
    },
  });
}

async function requestGitHubApi<Value>(
  dependencies: GitHubApiDependencies,
  {
    headers,
    init,
    path,
    readSuccessfulResponse,
  }: {
    headers: HeadersInit;
    init?: RequestInit;
    path: string;
    readonly readSuccessfulResponse: (
      response: Response,
      signal: AbortSignal,
    ) => Value | Promise<Value>;
  },
): Promise<Value> {
  const requestHeaders = new Headers(headers);

  for (const [name, value] of new Headers(init?.headers)) {
    requestHeaders.set(name, value);
  }

  const requestUrl = githubApiRequestUrl(path);
  const deadlineSignal = AbortSignal.timeout(githubApiRequestDeadlineMilliseconds);
  const requestSignal =
    init?.signal === undefined || init.signal === null
      ? deadlineSignal
      : AbortSignal.any([deadlineSignal, init.signal]);

  try {
    const response = await awaitWithSignal(
      dependencies.fetch(requestUrl, {
        ...init,
        headers: requestHeaders,
        redirect: "manual",
        signal: requestSignal,
      }),
      requestSignal,
    );
    throwIfAborted(requestSignal);

    if (!response.ok) {
      const rateLimited = await githubResponseIsRateLimited(response, requestSignal);
      throwIfAborted(requestSignal);

      throw new GitHubApiError(response.status, `GitHub API request failed: ${path}`, rateLimited);
    }

    return await readSuccessfulResponse(response, requestSignal);
  } catch (error) {
    if (error instanceof GitHubApiError) {
      throw error;
    }

    throw new GitHubApiTransportError(`GitHub API request failed: ${path}`);
  }
}

async function githubResponseIsRateLimited(
  response: Response,
  signal: AbortSignal,
): Promise<boolean> {
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
    bodyRead = await readBodyUpTo(response.body, maxGitHubErrorBodyBytes, signal);
  } catch {
    throwIfAborted(signal);

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

function awaitWithSignal<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise((resolve, reject) => {
    const rejectForAbort = () => {
      reject(signal.reason);
    };
    const removeAbortListener = () => {
      signal.removeEventListener("abort", rejectForAbort);
    };

    signal.addEventListener("abort", rejectForAbort, { once: true });
    void operation.then(
      (value) => {
        removeAbortListener();
        resolve(value);
      },
      (error: unknown) => {
        removeAbortListener();
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason;
  }
}

function githubApiRequestUrl(path: string): URL {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new GitHubApiTransportError("GitHub API request path is invalid");
  }

  const queryStart = path.indexOf("?");
  const requestUrl = new URL(githubApiBaseUrl);

  requestUrl.pathname = queryStart === -1 ? path : path.slice(0, queryStart);
  if (queryStart !== -1) {
    requestUrl.search = path.slice(queryStart + 1);
  }

  return requestUrl;
}
