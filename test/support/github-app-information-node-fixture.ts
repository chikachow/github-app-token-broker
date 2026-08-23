import { testPrivateKeyPem } from "./rsa-test-key-pair.ts";
import { testGitHubInstallationResponse } from "./github-app-information.ts";
import type { TestOutboundRequest } from "./outbound-request.ts";

export const githubAppInformationNodeFixture = Object.freeze({
  appId: "2419473",
  privateKeyPem: testPrivateKeyPem,
  responseForRequest: githubAppInformationResponse,
});

function githubAppInformationResponse(request: TestOutboundRequest): Response | null {
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== "https://api.github.com") {
    return null;
  }

  if (url.pathname !== "/app/installations/12345") {
    return null;
  }

  if (
    request.headers.get("accept") !== "application/vnd.github+json" ||
    request.headers.get("x-github-api-version") !== "2022-11-28" ||
    !request.headers.get("authorization")?.startsWith("Bearer ")
  ) {
    throw new Error("invalid GitHub App Information request headers");
  }

  return Response.json(testGitHubInstallationResponse);
}
