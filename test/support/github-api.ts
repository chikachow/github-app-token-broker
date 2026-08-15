import {
  testInstallationId,
  testRepository,
  testRepositoryId,
  testRepositoryOwnerId,
  testRepositoryVisibility,
  testWorkflowDispatchInstallationId,
  testWorkflowDispatchRepository,
  testWorkflowDispatchRepositoryId,
} from "./constants.ts";

export async function fetchGitHubTestDouble(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const path = `${url.pathname}${url.search}`;
  const apiPath = gitHubApiPathForTestDouble(request);

  if (apiPath === null) {
    return new Response(null, { status: 404 });
  }

  if (request.headers.get("authorization") === null) {
    return new Response(null, { status: 401 });
  }

  if (request.method === "GET" && apiPath === `/repos/${testRepository}/installation`) {
    return githubInstallationResponse("fixture-owner", testInstallationId);
  }

  if (
    request.method === "GET" &&
    apiPath === `/repos/${testWorkflowDispatchRepository}/installation`
  ) {
    return githubInstallationResponse("fixture-target-owner", testWorkflowDispatchInstallationId);
  }

  if (request.method === "GET" && apiPath === `/repos/${testRepository}`) {
    return Response.json({
      default_branch: "fixture-base-branch",
      id: Number.parseInt(testRepositoryId, 10),
      owner: {
        id: Number.parseInt(testRepositoryOwnerId, 10),
      },
      visibility: testRepositoryVisibility,
    });
  }

  if (request.method === "GET" && apiPath === `/repos/${testWorkflowDispatchRepository}`) {
    return Response.json({
      default_branch: "fixture-base-branch",
      id: Number.parseInt(testWorkflowDispatchRepositoryId, 10),
      owner: {
        id: Number.parseInt(testRepositoryOwnerId, 10),
      },
      visibility: testRepositoryVisibility,
    });
  }

  if (
    request.method === "POST" &&
    apiPath === `/app/installations/${testInstallationId}/access_tokens`
  ) {
    const body = (await request.json()) as Record<string, unknown>;
    const permissions = body["permissions"];

    if (
      request.headers.get("content-type") !== "application/json" ||
      request.headers.get("x-github-stateless-s2s-token") !== "disabled" ||
      !hasSelectedRepository(body, testRepository) ||
      permissions === null ||
      typeof permissions !== "object" ||
      Array.isArray(permissions)
    ) {
      return new Response(null, { status: 500 });
    }

    const requestedPermissions = permissions as Record<string, unknown>;

    const hasMatchingContentAndPullRequestPermissions =
      Object.keys(requestedPermissions).length === 2 &&
      requestedPermissions["contents"] === requestedPermissions["pull_requests"];
    const permissionLevel =
      hasMatchingContentAndPullRequestPermissions &&
      (requestedPermissions["contents"] === "read" || requestedPermissions["contents"] === "write")
        ? requestedPermissions["contents"]
        : null;

    if (permissionLevel === null) {
      return new Response(null, { status: 500 });
    }

    return Response.json(
      {
        expires_at: "2030-01-01T00:00:00Z",
        permissions: {
          contents: permissionLevel,
          pull_requests: permissionLevel,
        },
        token: permissionLevel === "read" ? "ghs_test_read_token" : "ghs_test_token",
      },
      { status: 201 },
    );
  }

  if (
    request.method === "POST" &&
    apiPath === `/app/installations/${testWorkflowDispatchInstallationId}/access_tokens`
  ) {
    const body = (await request.json()) as Record<string, unknown>;
    const permissions = body["permissions"];

    if (
      request.headers.get("content-type") !== "application/json" ||
      request.headers.get("x-github-stateless-s2s-token") !== "disabled" ||
      !hasSelectedRepository(body, testWorkflowDispatchRepository) ||
      permissions === null ||
      typeof permissions !== "object" ||
      Array.isArray(permissions)
    ) {
      return new Response(null, { status: 500 });
    }

    const requestedPermissions = permissions as Record<string, unknown>;

    if (
      Object.keys(requestedPermissions).length !== 1 ||
      requestedPermissions["actions"] !== "write"
    ) {
      return new Response(null, { status: 500 });
    }

    return Response.json(
      {
        expires_at: "2030-01-01T00:00:00Z",
        permissions: {
          actions: "write",
        },
        token: "ghs_test_workflow_dispatch_token",
      },
      { status: 201 },
    );
  }

  return new Response(`No test GitHub response for ${request.method} ${path}`, { status: 404 });
}

export function githubInstallationResponse(accountLogin: string, installationId: number): Response {
  return Response.json({ account: { login: accountLogin }, id: installationId });
}

function hasSelectedRepository(body: Record<string, unknown>, repository: string): boolean {
  const repositories = body["repositories"];

  return (
    body["repository_ids"] === undefined &&
    Array.isArray(repositories) &&
    repositories.length === 1 &&
    repositories[0] === repositoryName(repository)
  );
}

function repositoryName(repository: string): string {
  return repository.split("/")[1] ?? repository;
}

function gitHubApiPathForTestDouble(request: Request): string | null {
  const url = new URL(request.url);

  if (url.hostname !== "example.test" && url.hostname !== "api.github.com") {
    return null;
  }

  return url.pathname.replace(/^\/__test\/github/u, "");
}
