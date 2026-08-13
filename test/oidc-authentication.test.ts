import { describe, expect, it, vi } from "vitest";

import type {
  OidcIdTokenAuthenticationResult,
  OidcIdTokenAuthenticator,
} from "@github-app-token-broker/oidc/id-token-authenticator";
import { createAuthenticateSubjectToken } from "../packages/token-exchange/src/authentication.ts";

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
    const authenticator: OidcIdTokenAuthenticator = {
      authenticateIdToken: async () => failure,
    };
    const authenticateSubjectToken = createAuthenticateSubjectToken(authenticator);
    const observe = vi.fn();

    await expect(
      authenticateSubjectToken("token", {
        observe,
        request: { path: "/automation/token", userAgent: "test-agent" },
      }),
    ).resolves.toMatchObject({
      ...failure.failure.diagnostics,
      ok: false,
      reason,
    });
    expect(observe).toHaveBeenCalledWith({
      ...failure.failure.diagnostics,
      event: "oidc_authentication_failed",
      level: "warn",
      path: "/automation/token",
      reason,
      userAgent: "test-agent",
    });
  });
});
