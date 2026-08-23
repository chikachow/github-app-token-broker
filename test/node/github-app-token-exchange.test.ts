import { createGitHubAppTokenExchange } from "@github-app-token-broker/token-exchange";
import { describe, expect, it, vi } from "vitest";

import {
  testGitHubAppTokenExchangeConfiguration as configuration,
  tokenExchangeRequest as tokenRequest,
} from "../support/github-app-token-exchange.ts";
import { testInstallationId, testNow, testRepository } from "../support/constants.ts";
import { fetchGitHubTestDouble } from "../support/github-api.ts";
import { fetchOidcRemoteDocumentResponseTestDouble } from "../support/oidc.ts";

describe("GitHub App Token Exchange Node runtime", () => {
  it("awaits successful revocation before failing closed on a post-mint observation failure", async () => {
    const observerFailure = "private post-mint observer failure";
    const githubRequests: Request[] = [];
    const observedEvents: unknown[] = [];
    let completeRevocation: (response: Response) => void = () => undefined;
    let markRevocationStarted: () => void = () => undefined;
    const revocation = new Promise<Response>((resolve) => {
      completeRevocation = resolve;
    });
    const revocationStarted = new Promise<void>((resolve) => {
      markRevocationStarted = resolve;
    });
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: (input, init) => {
        const request = new Request(input, init);

        if (new URL(request.url).hostname === "token.actions.githubusercontent.com") {
          return fetchOidcRemoteDocumentResponseTestDouble(request);
        }

        githubRequests.push(request);

        if (
          request.method === "DELETE" &&
          new URL(request.url).pathname === "/installation/token"
        ) {
          markRevocationStarted();

          return revocation;
        }

        return fetchGitHubTestDouble(request);
      },
      now: () => testNow,
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      let responseSettled = false;
      const responsePromise = tokenExchange(await tokenRequest(), {
        observe: async (observation) => {
          const event = observation.fields["event"];
          observedEvents.push(event);

          if (event === "installation_access_token_issuance_succeeded") {
            throw new Error(observerFailure);
          }
        },
      }).then((response) => {
        responseSettled = true;

        return response;
      });

      await revocationStarted;
      await Promise.resolve();
      expect(responseSettled).toBe(false);
      completeRevocation(new Response(null, { status: 204 }));
      const response = await responsePromise;
      const responseBody = await response.json();

      expect(response.status).toBe(500);
      expect(responseBody).toEqual({ error: "server_error" });
      expect(JSON.stringify(responseBody)).not.toContain("ghs_test_token");
      expect(observedEvents).toEqual([
        "installation_access_token_issuance_started",
        "installation_access_token_issuance_succeeded",
      ]);
      expect(
        githubRequests.map((request) => ({
          method: request.method,
          path: new URL(request.url).pathname,
        })),
      ).toEqual([
        { method: "GET", path: `/repos/${testRepository}/installation` },
        { method: "POST", path: `/app/installations/${testInstallationId}/access_tokens` },
        { method: "DELETE", path: "/installation/token" },
      ]);
      expect(githubRequests[2]?.headers.get("authorization")).toBe("Bearer ghs_test_token");
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(observerFailure);
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("ghs_test_token");
    } finally {
      consoleError.mockRestore();
    }
  });
});
