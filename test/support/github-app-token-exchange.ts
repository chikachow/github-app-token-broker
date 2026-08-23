import { githubActionsOidcProviderRegistration } from "@github-app-token-broker/oidc-provider-github-actions";
import type {
  GitHubAppTokenExchangeConfiguration,
  TokenExchangeRequestContext,
} from "@github-app-token-broker/token-exchange";

import { fetchGitHubTestDouble } from "./github-api.ts";
import { fetchOidcRemoteDocumentResponseTestDouble, tokenExchangeRequestBody } from "./oidc.ts";
import { testPrivateKeyPem } from "./rsa-test-key-pair.ts";
import { testTokenIssuancePolicy } from "./token-issuance-policy.ts";

export const testGitHubAppTokenExchangeConfiguration = {
  composition: {
    oidcProviderRegistrations: [githubActionsOidcProviderRegistration],
    tokenIssuancePolicy: testTokenIssuancePolicy,
  },
  githubApp: {
    appId: "2419473",
    privateKey: testPrivateKeyPem,
  },
  subjectTokenAudience: "https://broker.example",
} satisfies GitHubAppTokenExchangeConfiguration;

export function fetchTokenExchangeExternalTestDouble(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);

  return new URL(request.url).hostname === "token.actions.githubusercontent.com"
    ? fetchOidcRemoteDocumentResponseTestDouble(request)
    : fetchGitHubTestDouble(request);
}

export function tokenExchangeRequestContext(): TokenExchangeRequestContext {
  return {
    observe: async () => undefined,
    observeOidcDiagnostic: () => undefined,
  };
}

export async function tokenExchangeRequest(form: Record<string, string> = {}): Promise<Request> {
  return new Request("https://broker.example/token", {
    body: await tokenExchangeRequestBody({ form }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
}
