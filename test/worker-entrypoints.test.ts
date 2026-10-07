import { testGitHubActionsTokenExchangeComposition } from "./support/worker.ts";
import { githubActionsTokenExchangeRequestBody } from "./support/github-actions-token-exchange.ts";
import { describe, expect, it, vi } from "vitest";

import { githubActionsOidcProviderRegistration } from "@github-app-token-broker/oidc-provider-github-actions";
import {
  compileTokenIssuancePolicy,
  githubRepositoryResourceConstraint,
  oidcSubjectTokenConstraint,
} from "@github-app-token-broker/token-issuance-policy";
import {
  createTokenExchangeWorker,
  createGitHubAppInformationEntrypoint,
} from "@github-app-token-broker/worker";
import { parseOidcIssuerIdentifier } from "@github-app-token-broker/oidc/provider-registration";
import genericTokenExchangeWorker from "../workers/github-app-token-broker/src/generic-worker.ts";
import { testGitHubActionsTokenIssuancePolicy } from "./support/github-actions-token-issuance-policy.ts";

describe("worker entrypoint shapes", () => {
  it("exports only the reviewed GitHub App Information RPC methods", () => {
    expect(Object.getOwnPropertyNames(createGitHubAppInformationEntrypoint([]).prototype)).toEqual([
      "constructor",
      "getApp",
      "listInstallations",
      "getInstallation",
      "getRepositoryInstallation",
    ]);
  });

  it("rejects duplicate OIDC Provider Registration issuers when composed", () => {
    expect(() =>
      createTokenExchangeWorker({
        githubApps: testGitHubActionsTokenExchangeComposition.githubApps,
        oidcProviderRegistrations: [
          githubActionsOidcProviderRegistration,
          githubActionsOidcProviderRegistration,
        ],
        tokenIssuancePolicy: testGitHubActionsTokenIssuancePolicy,
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
        githubApps: testGitHubActionsTokenExchangeComposition.githubApps,
        oidcProviderRegistrations: [],
        tokenIssuancePolicy: compileTokenIssuancePolicy([
          {
            githubAppClientId: "Iv1.fixtureApp",
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
        githubApps: testGitHubActionsTokenExchangeComposition.githubApps,
        oidcProviderRegistrations: [githubActionsOidcProviderRegistration],
        tokenIssuancePolicy: compileTokenIssuancePolicy([]),
      }),
    ).not.toThrow();
  });

  it("does no network I/O while composing a Worker", () => {
    const fetchExternal = vi.fn<typeof fetch>();

    createTokenExchangeWorker(
      {
        githubApps: testGitHubActionsTokenExchangeComposition.githubApps,
        oidcProviderRegistrations: [githubActionsOidcProviderRegistration],
        tokenIssuancePolicy: testGitHubActionsTokenIssuancePolicy,
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
          new Request("https://example.test/github/apps/fixture-app/token", {
            body: await githubActionsTokenExchangeRequestBody(),
            headers: { "content-type": "application/x-www-form-urlencoded" },
            method: "POST",
          }) as Parameters<typeof handler>[0],
          {
            TOKEN_EXCHANGE_RATE_LIMIT: { limit: async () => ({ success: true }) },
          },
          {} as ExecutionContext,
        ),
      );

      expect(response.status).toBe(404);
      expect(response.headers.get("www-authenticate")).toBeNull();
      await expect(response.json()).resolves.toMatchObject({ status: 404 });
      expect(fetchExternal).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
