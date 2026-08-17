import { describe, expect, it } from "vitest";

import type {
  OidcIdTokenAuthenticationResult,
  OidcIdTokenAuthenticator,
} from "@github-app-token-broker/oidc/id-token-authenticator";
import { authenticateOidcIdToken } from "../workers/github-app-token-broker/src/authentication.ts";
import type { TokenExchangeObservation } from "../workers/github-app-token-broker/src/observability.ts";

type AuthenticationFailure = Extract<OidcIdTokenAuthenticationResult, { ok: false }>;

describe("OIDC authentication HTTP boundary", () => {
  it.each<[string, AuthenticationFailure, string]>([
    [
      "provider unavailability",
      {
        failure: {
          diagnostics: {
            diagnosticCode: "ERR_OIDC_PROVIDER_CONFIGURATION_FETCH_FAILED",
            providerHttpStatus: 503,
          },
          kind: "provider_unavailable",
        },
        ok: false,
      },
      "oidc_provider_failure",
    ],
    [
      "an internal failure",
      {
        failure: {
          diagnostics: {},
          kind: "internal_failure",
        },
        ok: false,
      },
      "oidc_internal_failure",
    ],
    [
      "subject-token rejection",
      {
        failure: {
          diagnostics: { diagnosticCode: "ERR_JWT_INVALID" },
          kind: "subject_token_rejected",
        },
        ok: false,
      },
      "invalid_token",
    ],
  ])("maps %s", async (_description, failure, reason) => {
    const request = new Request("https://github-app-token-broker.example/token");
    const authenticator: OidcIdTokenAuthenticator = {
      authenticateIdToken: async () => failure,
    };
    const observations: TokenExchangeObservation[] = [];

    await expect(
      authenticateOidcIdToken("token", request, authenticator, (observation) =>
        observations.push(observation),
      ),
    ).resolves.toMatchObject({
      ...failure.failure.diagnostics,
      ok: false,
      reason,
    });
    expect(observations).toEqual([
      {
        fields: {
          ...failure.failure.diagnostics,
          path: "/token",
          rayId: null,
          reason,
          userAgent: null,
        },
        level: "warn",
        message: "OIDC authentication failed",
      },
    ]);
  });
});
