import { githubActionsOidcProviderRegistration } from "@github-app-token-broker/oidc-provider-github-actions";
import type { GitHubAppTokenExchangeConfiguration } from "@github-app-token-broker/token-exchange";

import { fetchGitHubTestDouble } from "./github-api.ts";
import { fetchGitHubActionsOidcRemoteDocumentTestDouble } from "./github-actions-oidc.ts";
import { githubActionsIdTokenPayload } from "./github-actions.ts";
import { signRs256Jwt } from "./jwt.ts";
import { tokenExchangeRequestBody } from "./token-exchange-request.ts";
import { testPrivateKeyPem } from "./rsa-test-key-pair.ts";
import { testGitHubActionsTokenIssuancePolicy } from "./github-actions-token-issuance-policy.ts";

export const testGitHubActionsTokenExchangeConfiguration = {
  composition: {
    oidcProviderRegistrations: [githubActionsOidcProviderRegistration],
    tokenIssuancePolicy: testGitHubActionsTokenIssuancePolicy,
  },
  githubApp: {
    appId: "2419473",
    privateKey: testPrivateKeyPem,
  },
  subjectTokenAudience: "https://broker.example",
} satisfies GitHubAppTokenExchangeConfiguration;

export function fetchGitHubActionsTokenExchangeExternalTestDouble(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);

  return new URL(request.url).hostname === "token.actions.githubusercontent.com"
    ? fetchGitHubActionsOidcRemoteDocumentTestDouble(request)
    : fetchGitHubTestDouble(request);
}

interface GitHubActionsTokenExchangeRequestOptions {
  claimOverrides?: Record<string, unknown>;
  formOverrides?: Partial<Record<string, string | null>>;
}

export async function githubActionsTokenExchangeRequestBody({
  claimOverrides,
  formOverrides,
}: GitHubActionsTokenExchangeRequestOptions = {}): Promise<string> {
  const subjectToken = await signRs256Jwt(testPrivateKeyPem, {
    ...githubActionsIdTokenPayload,
    ...claimOverrides,
  });
  return tokenExchangeRequestBody(
    {
      subjectToken,
      resource: "https://api.github.com/repos/fixture-owner/fixture-source-repository",
      scope: "contents:write pull_requests:write",
    },
    formOverrides,
  );
}

export async function githubActionsTokenExchangeRequest(
  options: GitHubActionsTokenExchangeRequestOptions = {},
): Promise<Request> {
  return new Request("https://broker.example/token", {
    body: await githubActionsTokenExchangeRequestBody(options),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
}
