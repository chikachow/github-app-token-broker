import { describe, expect, it, vi } from "vitest";

import {
  createOidcIdTokenAuthenticator,
  type OidcIdTokenAuthenticationEvent,
  type OidcIdTokenAuthenticationFailure,
  type OidcVerificationEvidence,
  type VerifiedSubjectToken,
} from "@github-app-token-broker/oidc/id-token-authenticator";
import {
  createOidcProviderRegistration,
  type OidcIdTokenSigningAlgorithm,
} from "@github-app-token-broker/oidc/provider-registration";

import {
  authenticationTestNow,
  type AuthenticationFailure,
  expectedFailure,
  issuer,
  jwksUri,
  providerFetch,
  registration,
  signedIdToken,
  subjectTokenAudience,
  successfulProviderFetch,
} from "./support/oidc-id-token-authenticator-fixture.ts";

describe("OIDC ID Token Authenticator", () => {
  it("rejects duplicate provider registrations", () => {
    expect(() =>
      createOidcIdTokenAuthenticator(
        {
          providerRegistrations: [registration, registration],
          subjectTokenAudience,
        },
        { fetch: successfulProviderFetch, now: () => authenticationTestNow },
      ),
    ).toThrow("duplicate OIDC Provider Registration issuer");
  });

  it("revalidates and snapshots structurally supplied Provider Registrations", async () => {
    const acceptedIdTokenSigningAlgorithms: OidcIdTokenSigningAlgorithm[] = ["RS256"];
    const structuralRegistration = {
      acceptedIdTokenSigningAlgorithms,
      idTokenProfile: { validate: () => true },
      issuer: registration.issuer,
    };
    const replacementRegistration = createOidcProviderRegistration({
      acceptedIdTokenSigningAlgorithms: ["RS256"],
      idTokenProfile: { validate: () => true },
      issuer: "https://replacement.example",
    });
    const authenticator = createOidcIdTokenAuthenticator(
      {
        providerRegistrations: [structuralRegistration],
        subjectTokenAudience,
      },
      { fetch: successfulProviderFetch, now: () => authenticationTestNow },
    );

    acceptedIdTokenSigningAlgorithms.splice(0);
    structuralRegistration.issuer = replacementRegistration.issuer;

    await expect(authenticator.authenticateIdToken(await signedIdToken())).resolves.toMatchObject({
      ok: true,
    });
    expect(() =>
      createOidcIdTokenAuthenticator(
        {
          providerRegistrations: [
            {
              ...structuralRegistration,
              acceptedIdTokenSigningAlgorithms: [],
            },
          ],
          subjectTokenAudience,
        },
        { fetch: successfulProviderFetch, now: () => authenticationTestNow },
      ),
    ).toThrow("invalid OIDC ID Token signing algorithm allowlist");
  });

  it("rejects malformed and unregistered issuers before provider I/O", async () => {
    const fetchOidcRemoteDocumentResponse = vi.fn(successfulProviderFetch);
    const authenticator = testAuthenticator(fetchOidcRemoteDocumentResponse);

    await expect(
      authenticator.authenticateIdToken(
        await signedIdToken({ tokenIssuer: "https://attacker.example" }),
      ),
    ).resolves.toEqual(expectedFailure("subject_token_rejected", "ERR_OIDC_ISSUER_NOT_REGISTERED"));
    await expect(authenticator.authenticateIdToken("not-a-jwt")).resolves.toEqual(
      expectedFailure("subject_token_rejected", "ERR_JWT_INVALID"),
    );
    await expect(
      authenticator.authenticateIdToken(await signedIdToken({ claims: { iss: "" } })),
    ).resolves.toEqual(expectedFailure("subject_token_rejected", "ERR_JWT_INVALID"));
    expect(fetchOidcRemoteDocumentResponse).not.toHaveBeenCalled();
  });

  it("routes an exact registered issuer to its verifier result", async () => {
    const fetchOidcRemoteDocumentResponse = vi.fn(successfulProviderFetch);
    const authenticator = testAuthenticator(fetchOidcRemoteDocumentResponse);
    const verificationEvidence: OidcVerificationEvidence = { resolvedKeyId: "test-key-1" };
    const verifiedSubjectToken: Pick<VerifiedSubjectToken, "issuer"> = {
      issuer: registration.issuer,
    };

    await expect(authenticator.authenticateIdToken(await signedIdToken())).resolves.toMatchObject({
      ok: true,
      verificationEvidence,
      verifiedSubjectToken,
    });
    expect(
      fetchOidcRemoteDocumentResponse.mock.calls.map(([input]) => new Request(input).url),
    ).toEqual([`${issuer}/.well-known/openid-configuration`, jwksUri]);
  });

  it("enforces the provider deadline while waiting for response headers", async () => {
    const deadline = new AbortController();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);

    try {
      const fetchStarted = Promise.withResolvers<void>();
      let requestSignal: AbortSignal | null | undefined;
      const authenticator = testAuthenticator(async (_input, init) => {
        requestSignal = init?.signal;
        fetchStarted.resolve();

        return new Promise<Response>(() => undefined);
      });
      const authentication = authenticator.authenticateIdToken(await signedIdToken());

      await fetchStarted.promise;
      expect(timeout).toHaveBeenCalledWith(5_000);
      expect(requestSignal).toBe(deadline.signal);

      const didNotSettleAfterAbort = new Promise<never>((_resolve, reject) => {
        deadline.signal.addEventListener(
          "abort",
          () => {
            watchdog = setTimeout(() => {
              reject(new Error("OIDC authentication did not settle after the provider deadline"));
            }, 0);
          },
          { once: true },
        );
      });

      deadline.abort(new DOMException("private provider timeout detail", "TimeoutError"));

      await expect(Promise.race([authentication, didNotSettleAfterAbort])).resolves.toEqual(
        expectedFailure("provider_unavailable", "ERR_OIDC_PROVIDER_CONFIGURATION_TIMEOUT"),
      );
    } finally {
      clearTimeout(watchdog);
      timeout.mockRestore();
    }
  });

  it("resolves per-call and default diagnostic observers at the public seam", async () => {
    const defaultEvents: OidcIdTokenAuthenticationEvent[] = [];
    const requestEvents: OidcIdTokenAuthenticationEvent[] = [];
    const authenticator = createOidcIdTokenAuthenticator(
      {
        providerRegistrations: [registration],
        subjectTokenAudience,
      },
      {
        fetch: providerFetch({ cacheControl: "no-store" }),
        now: () => authenticationTestNow,
        observe: (event) => defaultEvents.push(event),
      },
    );
    const subjectToken = await signedIdToken();

    await expect(
      authenticator.authenticateIdToken(subjectToken, (event) => requestEvents.push(event)),
    ).resolves.toMatchObject({ ok: true });
    expect(requestEvents).toContainEqual(
      expect.objectContaining({ event: "oidc_provider_configuration_refreshed" }),
    );
    expect(defaultEvents).toEqual([]);

    await expect(authenticator.authenticateIdToken(subjectToken)).resolves.toMatchObject({
      ok: true,
    });
    expect(defaultEvents).toContainEqual(
      expect.objectContaining({ event: "oidc_provider_configuration_refreshed" }),
    );
  });

  it("makes provider HTTP status impossible on non-provider failures", () => {
    const subjectTokenRejection: AuthenticationFailure = expectedFailure(
      "subject_token_rejected",
      "ERR_JWT_INVALID",
    );
    const rejection: OidcIdTokenAuthenticationFailure = subjectTokenRejection.failure;
    const invalidSubjectTokenRejection: AuthenticationFailure = {
      failure: {
        // @ts-expect-error Provider HTTP status is not valid subject-token rejection diagnostics.
        diagnostics: { providerHttpStatus: 401 },
        kind: "subject_token_rejected",
      },
      ok: false,
    };

    expect(rejection.kind).toBe("subject_token_rejected");
    expect(invalidSubjectTokenRejection.failure.kind).toBe("subject_token_rejected");
  });
});

function testAuthenticator(fetchOidcRemoteDocumentResponse: typeof fetch) {
  return createOidcIdTokenAuthenticator(
    {
      providerRegistrations: [registration],
      subjectTokenAudience,
    },
    { fetch: fetchOidcRemoteDocumentResponse, now: () => authenticationTestNow },
  );
}
