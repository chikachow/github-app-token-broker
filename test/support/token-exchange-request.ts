import type { TokenExchangeRequestContext } from "@github-app-token-broker/token-exchange";

import { accessTokenType, oidcIdTokenType, tokenExchangeGrantType } from "./constants.ts";

export function tokenExchangeRequestBody(
  input: { subjectToken: string; resource: string; scope: string },
  overrides: Partial<Record<string, string | null>> = {},
): string {
  const form = new URLSearchParams({
    grant_type: tokenExchangeGrantType,
    requested_token_type: accessTokenType,
    subject_token_type: oidcIdTokenType,
    subject_token: input.subjectToken,
    resource: input.resource,
    scope: input.scope,
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) form.delete(key);
    else if (value !== undefined) form.set(key, value);
  }
  return form.toString();
}

export function tokenExchangeRequestContext(): TokenExchangeRequestContext {
  return {
    observe: async () => undefined,
    observeOidcDiagnostic: () => undefined,
  };
}
