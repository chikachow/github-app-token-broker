import { describe, expect, it, vi } from "vitest";

import { githubActionsOidcProviderRegistration } from "@github-app-token-broker/oidc-provider-github-actions";
import {
  compileTokenIssuancePolicy,
  githubRepositoryResourceConstraint,
  oidcSubjectTokenConstraint,
} from "@github-app-token-broker/token-issuance-policy";
import { createTokenExchangeWorker } from "@github-app-token-broker/worker";
import { parseOidcIssuerIdentifier } from "@github-app-token-broker/oidc/provider-registration";
import genericTokenExchangeWorker from "../workers/github-app-token-broker/src/generic-worker.ts";
import { tokenExchangeRequestBody } from "./support/worker.ts";
import { testTokenIssuancePolicy } from "./support/token-issuance-policy.ts";

describe("worker entrypoint shapes", () => {
  it("rejects duplicate OIDC Provider Registration issuers when composed", () => {
    expect(() =>
      createTokenExchangeWorker({
        oidcProviderRegistrations: [
          githubActionsOidcProviderRegistration,
          githubActionsOidcProviderRegistration,
        ],
        tokenIssuancePolicy: testTokenIssuancePolicy,
      }),
    ).toThrow("duplicate OIDC Provider Registration issuer");
  });

  it("rejects unregistered policy issuers when composed", () => {
    const issuer = parseOidcIssuerIdentifier("https://unregistered.example");

    if (issuer === null) {
      throw new Error("invalid test issuer");
    }

    expect(() =>
      createTokenExchangeWorker({
        oidcProviderRegistrations: [],
        tokenIssuancePolicy: compileTokenIssuancePolicy([
          {
            permissions: { contents: "read" },
            resource: githubRepositoryResourceConstraint("owner", "repository"),
            subjectToken: oidcSubjectTokenConstraint(issuer),
          },
        ]),
      }),
    ).toThrow("Token Issuance Policy references unregistered OIDC Issuer Identifiers");
  });

  it("allows an empty deny-all policy and unused registrations", () => {
    expect(() =>
      createTokenExchangeWorker({
        oidcProviderRegistrations: [githubActionsOidcProviderRegistration],
        tokenIssuancePolicy: compileTokenIssuancePolicy([]),
      }),
    ).not.toThrow();
  });

  it("does no network I/O while composing a Worker", () => {
    const fetchExternal = vi.fn<typeof fetch>();

    createTokenExchangeWorker(
      {
        oidcProviderRegistrations: [githubActionsOidcProviderRegistration],
        tokenIssuancePolicy: testTokenIssuancePolicy,
      },
      { fetch: fetchExternal, now: () => new Date() },
    );

    expect(fetchExternal).not.toHaveBeenCalled();
  });

  it("rejects a validly formed request at the generic deny-all endpoint without GitHub I/O", async () => {
    const fetchExternal = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchExternal);

    try {
      expect(genericTokenExchangeWorker.fetch).toEqual(expect.any(Function));
      expect(genericTokenExchangeWorker.queue).toBeUndefined();
      const handler = genericTokenExchangeWorker.fetch;

      if (handler === undefined) {
        throw new Error("generic Worker has no fetch handler");
      }

      const response = await Promise.resolve(
        handler(
          new Request("https://example.test/token", {
            body: await tokenExchangeRequestBody(),
            headers: { "content-type": "application/x-www-form-urlencoded" },
            method: "POST",
          }) as Parameters<typeof handler>[0],
          {
            GITHUB_APP_ID: "000000",
            GITHUB_APP_PRIVATE_KEY: "unused",
            TOKEN_BROKER_AUDIENCE: "https://broker.example",
            TOKEN_EXCHANGE_RATE_LIMIT: { limit: async () => ({ success: true }) },
          },
          {} as ExecutionContext,
        ),
      );

      expect(response.status).toBe(400);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
      expect(fetchExternal).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
