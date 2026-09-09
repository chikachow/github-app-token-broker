import type { JWTPayload } from "jose";

export const githubActionsIdTokenPayload = Object.freeze({
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
  iss: "https://token.actions.githubusercontent.com",
  sub: "repo:fixture-owner/fixture-source-repository:ref:refs/heads/fixture-base-branch",
  aud: "https://broker.example",
  iat: 1779580790,
  nbf: 1779580790,
  exp: 1779581100,
} satisfies JWTPayload);
