import { describe, expect, it, vi } from "vitest";

import { githubActionsOidcProviderRegistration } from "@github-app-token-broker/oidc-provider-github-actions";
import {
  compileTokenIssuancePolicy,
  githubRepositoryResourceConstraint,
  oidcSubjectTokenConstraint,
} from "@github-app-token-broker/token-issuance-policy";
import * as tokenExchangeWorkerPackage from "@github-app-token-broker/worker";
import { createTokenExchangeWorker } from "@github-app-token-broker/worker";
import { parseOidcIssuerIdentifier } from "@github-app-token-broker/oidc/provider-registration";
import genericTokenExchangeWorker from "../workers/github-app-token-broker/src/generic-worker.ts";
import { testTokenIssuancePolicy } from "./support/token-issuance-policy.ts";
import rootHarness from "./support/root-test-harness.ts";

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

  it("keeps the Worker package Interface named-only", () => {
    expect("default" in tokenExchangeWorkerPackage).toBe(false);
    expect(tokenExchangeWorkerPackage.createTokenExchangeWorker).toEqual(expect.any(Function));
  });

  it("provides a generic deny-all Worker entrypoint separately", async () => {
    expect(genericTokenExchangeWorker.fetch).toEqual(expect.any(Function));
    expect(genericTokenExchangeWorker.queue).toBeUndefined();
    const handler = genericTokenExchangeWorker.fetch;

    if (handler === undefined) {
      throw new Error("generic Worker has no fetch handler");
    }

    const response = await Promise.resolve(
      handler(
        new Request("https://example.test/not-token") as Parameters<typeof handler>[0],
        {
          GITHUB_APP_ID: "000000",
          GITHUB_APP_PRIVATE_KEY: "unused",
          TOKEN_BROKER_AUDIENCE: "https://broker.example",
          TOKEN_EXCHANGE_RATE_LIMIT: { limit: async () => ({ success: true }) },
        },
        {} as ExecutionContext,
      ),
    );

    expect(response.status).toBe(404);
  });

  it("does not route product endpoints through the root test harness", async () => {
    const response = await Promise.resolve(
      rootHarness.fetch(new Request("https://example.test/token"), {}, {} as ExecutionContext),
    );

    expect(response.status).toBe(404);
  });
});
