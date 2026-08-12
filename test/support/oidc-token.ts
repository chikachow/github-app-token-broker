import { importPKCS8, SignJWT } from "jose";

import {
  accessTokenType,
  oidcIdTokenType,
  testRepository,
  tokenExchangeGrantType,
} from "./constants.ts";

export const testGithubActionsIssuer = "https://token.actions.githubusercontent.com";

export interface CreateOidcTokenOptions {
  audience?: string | string[] | null;
  issuer?: string;
  kid?: string;
  notBefore?: number;
}

export interface TokenExchangeRequestBodyOptions {
  claims?: Partial<Record<string, unknown>>;
  form?: Partial<Record<string, string | null>>;
  requestedTokenType?: string | null;
  tokenOptions?: CreateOidcTokenOptions;
}

export async function createTokenExchangeRequestBody(
  privateKeyPem: string,
  {
    claims,
    form: formOptions,
    requestedTokenType = accessTokenType,
    tokenOptions,
  }: TokenExchangeRequestBodyOptions = {},
): Promise<string> {
  const subjectToken = await createOidcToken(privateKeyPem, claims, tokenOptions);
  const form = new URLSearchParams({
    grant_type: tokenExchangeGrantType,
    resource: `https://api.github.com/repos/${testRepository}`,
    scope: "contents:write pull_requests:write",
    subject_token: subjectToken,
    subject_token_type: oidcIdTokenType,
  });

  if (requestedTokenType !== null) {
    form.set("requested_token_type", requestedTokenType);
  }

  for (const [key, value] of Object.entries(formOptions ?? {})) {
    if (value === null) {
      form.delete(key);
    } else if (value !== undefined) {
      form.set(key, value);
    }
  }

  return form.toString();
}

export async function createOidcToken(
  privateKeyPem: string,
  overrides?: Partial<Record<string, unknown>>,
  options?: CreateOidcTokenOptions,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const privateKey = await importPKCS8(privateKeyPem, "RS256");
  const { sub, ...payloadOverrides } = overrides ?? {};
  const audience = options?.audience === undefined ? "https://broker.example" : options.audience;
  let jwt = new SignJWT({
    actor: "dependabot[bot]",
    base_ref: "",
    event_name: "workflow_dispatch",
    head_ref: "",
    ref: "refs/heads/fixture-base-branch",
    ref_type: "branch",
    repository: "fixture-owner/fixture-source-repository",
    repository_id: "123456789",
    repository_owner_id: "555555",
    repository_visibility: "private",
    run_attempt: "1",
    run_id: "987654321",
    sha: "0123456789abcdef0123456789abcdef01234567",
    workflow: "fixture token request",
    workflow_ref:
      "fixture-owner/fixture-source-repository/.github/workflows/fixture-token-request.yml@refs/heads/fixture-base-branch",
    ...payloadOverrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: options?.kid ?? "test-key-1" })
    .setIssuer(options?.issuer ?? testGithubActionsIssuer)
    .setIssuedAt(now - 10)
    .setNotBefore(options?.notBefore ?? now - 10)
    .setExpirationTime(now + 300)
    .setSubject(
      typeof sub === "string"
        ? sub
        : "repo:fixture-owner/fixture-source-repository:ref:refs/heads/fixture-base-branch",
    );

  if (audience !== null) {
    jwt = jwt.setAudience(audience);
  }

  return jwt.sign(privateKey);
}
