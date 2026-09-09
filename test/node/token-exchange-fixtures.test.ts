import { decodeJwt, importJWK, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";

import { githubActionsIdTokenPayload } from "../support/github-actions.ts";
import { githubActionsTokenExchangeRequest } from "../support/github-actions-token-exchange.ts";
import { signRs256Jwt } from "../support/jwt.ts";
import { testPrivateKeyPem, testPublicJwk } from "../support/rsa-test-key-pair.ts";
import { tokenExchangeRequestBody } from "../support/token-exchange-request.ts";

describe("Token Exchange fixtures", () => {
  it("signs exactly the supplied payload without provider or registered-claim defaults", async () => {
    const payload = { iss: "https://issuer.example", sub: "job:example", custom: null };
    const token = await signRs256Jwt(testPrivateKeyPem, payload, "explicit-key");
    const verified = await jwtVerify(token, await importJWK(testPublicJwk, "RS256"));

    expect(verified.payload).toEqual(payload);
    expect(verified.protectedHeader).toEqual({ alg: "RS256", kid: "explicit-key" });
  });

  it("preserves malformed registered claims without repairing them", async () => {
    const payload = { iss: null, sub: 42, aud: ["one", "two"], iat: "invalid" };
    const token = await signRs256Jwt(testPrivateKeyPem, payload);

    expect(decodeJwt(token)).toEqual(payload);
  });

  it("keeps GitHub Actions identity in the explicitly named request fixture", async () => {
    const request = await githubActionsTokenExchangeRequest();
    const form = new URLSearchParams(await request.text());
    const token = form.get("subject_token");
    if (token === null) throw new Error("expected fixture subject token");
    expect(decodeJwt(token)).toEqual(githubActionsIdTokenPayload);
    expect(decodeJwt(token)).toMatchObject({
      iss: "https://token.actions.githubusercontent.com",
      sub: "repo:fixture-owner/fixture-source-repository:ref:refs/heads/fixture-base-branch",
      aud: "https://broker.example",
      iat: 1779580790,
      nbf: 1779580790,
      exp: 1779581100,
    });
    expect(form.get("resource")).toBe(
      "https://api.github.com/repos/fixture-owner/fixture-source-repository",
    );
    expect(form.get("scope")).toBe("contents:write pull_requests:write");
  });

  it("assembles an explicit subject token and requested authority without signing or choosing identity", () => {
    const form = new URLSearchParams(
      tokenExchangeRequestBody(
        {
          subjectToken: "opaque-subject-token",
          resource: "https://api.github.com/repos/another/target",
          scope: "issues:read",
        },
        { requested_token_type: null, scope: "" },
      ),
    );
    expect([...form.entries()]).toEqual([
      ["grant_type", "urn:ietf:params:oauth:grant-type:token-exchange"],
      ["subject_token_type", "urn:ietf:params:oauth:token-type:id_token"],
      ["subject_token", "opaque-subject-token"],
      ["resource", "https://api.github.com/repos/another/target"],
      ["scope", ""],
    ]);
  });
});
