import { once } from "node:events";
import { createServer } from "node:http";

import { createOidcIdTokenAuthenticator } from "@github-app-token-broker/oidc/id-token-authenticator";
import { describe, expect, it, vi } from "vitest";

import {
  authenticationTestNow,
  expectedFailure,
  issuer,
  providerFetch,
  registration,
  signedIdToken,
  subjectTokenAudience,
} from "../support/oidc-id-token-authenticator-fixture.ts";

describe("OIDC HTTP Node runtime", () => {
  it("closes a native Fetch response after rejecting an unfinished provider error body", async () => {
    const responseClosed = Promise.withResolvers<void>();
    const upstream = createServer((_request, response) => {
      response.on("close", () => responseClosed.resolve());
      response.writeHead(503, { "content-type": "application/json" });
      response.write('{"message":"private upstream failure"}');
    });
    const listening = once(upstream, "listening");
    upstream.listen(0, "127.0.0.1");
    await listening;
    let closeDeadline: ReturnType<typeof setTimeout> | undefined;

    try {
      const address = upstream.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a loopback upstream address");
      }

      const authenticator = testAuthenticator(async (input, init) => {
        expect(input).toEqual(new URL(`${issuer}/.well-known/openid-configuration`));

        return fetch(`http://127.0.0.1:${address.port}`, init);
      });

      await expect(authenticator.authenticateIdToken(await signedIdToken())).resolves.toEqual(
        expectedFailure("provider_unavailable", "ERR_OIDC_PROVIDER_CONFIGURATION_HTTP_STATUS", 503),
      );
      await Promise.race([
        responseClosed.promise,
        new Promise<never>((_resolve, reject) => {
          closeDeadline = setTimeout(() => {
            reject(new Error("upstream response was not promptly closed"));
          }, 1000);
        }),
      ]);
    } finally {
      clearTimeout(closeDeadline);
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  it.each(["Provider Configuration", "JWK Set"] as const)(
    "cancels unused %s bodies without awaiting cleanup or changing rejection",
    async (documentKind) => {
      for (const responseInit of [
        { status: 503 },
        { status: 200, headers: { "content-type": "text/plain" } },
        {
          status: 200,
          headers: { "content-type": "application/json", "content-length": "262145" },
        },
      ]) {
        const cancel = vi.fn(() => new Promise<void>(() => undefined));
        const response = () =>
          new Response(new ReadableStream<Uint8Array>({ cancel }), responseInit);
        const authenticator = testAuthenticator(
          providerFetch(
            documentKind === "Provider Configuration"
              ? { providerConfigurationResponse: response }
              : { jwksResponse: response },
          ),
        );
        const result = await authenticator.authenticateIdToken(await signedIdToken());

        expect(result).toMatchObject({
          failure: {
            kind:
              documentKind === "Provider Configuration" && responseInit.status === 200
                ? "subject_token_rejected"
                : "provider_unavailable",
          },
          ok: false,
        });
        expect(cancel).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(["Fetch rejection", "cancellation rejection"] as const)(
    "contains a late %s after the provider deadline",
    async (failure) => {
      const deadline = new AbortController();
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
      const upstream = Promise.withResolvers<Response>();
      const requestStarted = Promise.withResolvers<void>();
      const cancel = vi.fn(async () => {
        throw new Error("private cancellation failure");
      });
      const authenticator = testAuthenticator(() => {
        requestStarted.resolve();

        return upstream.promise;
      });

      try {
        const result = authenticator.authenticateIdToken(await signedIdToken());
        await requestStarted.promise;
        deadline.abort(new DOMException("private deadline failure", "TimeoutError"));
        const expected = expectedFailure(
          "provider_unavailable",
          "ERR_OIDC_PROVIDER_CONFIGURATION_TIMEOUT",
        );
        await expect(result).resolves.toEqual(expected);

        if (failure === "Fetch rejection") {
          upstream.reject(new Error("private late Fetch failure"));
        } else {
          upstream.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
        }

        await new Promise(setImmediate);
        await expect(result).resolves.toEqual(expected);
        expect(cancel).toHaveBeenCalledTimes(failure === "Fetch rejection" ? 0 : 1);
      } finally {
        timeout.mockRestore();
      }
    },
  );

  it("cancels a response received immediately before the provider deadline", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const upstream = Promise.withResolvers<Response>();
    const requestStarted = Promise.withResolvers<void>();
    const cancel = vi.fn();
    const authenticator = testAuthenticator(() => {
      requestStarted.resolve();

      return upstream.promise;
    });

    try {
      const result = authenticator.authenticateIdToken(await signedIdToken());
      await requestStarted.promise;
      upstream.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
      queueMicrotask(() => {
        deadline.abort(new DOMException("private deadline failure", "TimeoutError"));
      });

      await expect(result).resolves.toEqual(
        expectedFailure("provider_unavailable", "ERR_OIDC_PROVIDER_CONFIGURATION_TIMEOUT"),
      );
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      timeout.mockRestore();
    }
  });
});

function testAuthenticator(fetchOidcRemoteDocumentResponse: typeof fetch) {
  return createOidcIdTokenAuthenticator(
    { providerRegistrations: [registration], subjectTokenAudience },
    { fetch: fetchOidcRemoteDocumentResponse, now: () => authenticationTestNow },
  );
}
