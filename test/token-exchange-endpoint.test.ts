import {
  createGitHubAppTokenExchange,
  type TokenExchangeObservation,
} from "@github-app-token-broker/token-exchange";
import { describe, expect, it, vi } from "vitest";

import {
  accessTokenType,
  oidcIdTokenType,
  testNow,
  tokenExchangeGrantType,
} from "./support/constants.ts";
import {
  fetchTokenExchangeExternalTestDouble as fetchExternal,
  testGitHubAppTokenExchangeConfiguration as configuration,
  tokenExchangeRequest as tokenRequest,
  tokenExchangeRequestContext as requestContext,
} from "./support/github-app-token-exchange.ts";
import { tokenExchangeRequestBody } from "./support/oidc.ts";

describe("Token Exchange Endpoint public handler", () => {
  it("validates method and media type without external I/O", async () => {
    const fetchExternal = vi.fn<typeof fetch>();
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: fetchExternal,
      now: () => testNow,
    });

    const methodResponse = await tokenExchange(
      new Request("https://broker.example/token", {
        body: await tokenExchangeRequestBody(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "PUT",
      }),
      requestContext(),
    );
    const mediaTypeResponse = await tokenExchange(
      new Request("https://broker.example/token", { body: "ignored", method: "POST" }),
      requestContext(),
    );

    expect(methodResponse.status).toBe(400);
    await expect(methodResponse.json()).resolves.toEqual({ error: "invalid_request" });
    expect(mediaTypeResponse.status).toBe(400);
    await expect(mediaTypeResponse.json()).resolves.toEqual({ error: "invalid_request" });
    expect(fetchExternal).not.toHaveBeenCalled();
  });

  it.each([
    ["Basic dW5zdXBwb3J0ZWQ=", 'Basic realm="github-app-token-broker"'],
    ["Bearer subject-token", 'Bearer realm="github-app-token-broker"'],
    ["1invalid credentials", 'Basic realm="github-app-token-broker"'],
  ])("rejects client authentication using the %s challenge", async (authorization, challenge) => {
    const fetchExternal = vi.fn<typeof fetch>();
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: fetchExternal,
      now: () => testNow,
    });
    const request = formRequest();
    request.headers.set("authorization", authorization);
    const response = await tokenExchange(request, requestContext());

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(challenge);
    await expect(response.json()).resolves.toEqual({ error: "invalid_client" });
    expect(fetchExternal).not.toHaveBeenCalled();
  });

  it.each([
    [
      "urn:chikachow:github-app-installation-access-token",
      "urn:chikachow:github-app-installation-access-token",
    ],
    [
      "urn:ietf:params:oauth:token-type:access_token",
      "urn:ietf:params:oauth:token-type:access_token",
    ],
  ])("echoes the supported requested token type %s", async (requestedTokenType, expectedType) => {
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: fetchExternal,
      now: () => testNow,
    });
    const response = await tokenExchange(
      await tokenRequest({ requested_token_type: requestedTokenType }),
      requestContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ issued_token_type: expectedType });
  });

  it("canonicalizes reordered permission scope in the response", async () => {
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: fetchExternal,
      now: () => testNow,
    });
    const response = await tokenExchange(
      await tokenRequest({ scope: "pull_requests:write contents:write" }),
      requestContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      scope: "contents:write pull_requests:write",
    });
  });

  it.each([
    ["missing grant type", { grant_type: null }, "invalid_request"],
    ["unsupported grant type", { grant_type: "urn:example:unsupported" }, "unsupported_grant_type"],
    ["missing subject token", { subject_token: null }, "invalid_request"],
    ["empty subject token", { subject_token: "" }, "invalid_request"],
    [
      "generic JWT subject-token type",
      { subject_token_type: "urn:ietf:params:oauth:token-type:jwt" },
      "invalid_request",
    ],
    ["missing requested token type", { requested_token_type: null }, "invalid_request"],
    [
      "unsupported requested token type",
      { requested_token_type: "urn:example:unknown" },
      "invalid_request",
    ],
    ["non-empty audience", { audience: "https://broker.example" }, "invalid_target"],
    ["missing scope", { scope: null }, "invalid_scope"],
    ["empty scope", { scope: "" }, "invalid_scope"],
    ["padded scope", { scope: " contents:write" }, "invalid_scope"],
    [
      "malformed resource",
      { resource: "https://github.com/fixture-owner/fixture-source-repository" },
      "invalid_target",
    ],
  ] as const)("rejects %s through the public handler", async (_scenario, overrides, error) => {
    const fetchExternal = vi.fn<typeof fetch>();
    const observe = vi.fn(async () => undefined);
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: fetchExternal,
      now: () => testNow,
    });
    const response = await tokenExchange(formRequest(overrides), { observe });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error });
    expect(observe).not.toHaveBeenCalled();
    expect(fetchExternal).not.toHaveBeenCalled();
  });

  it.each([
    "actor_token",
    "actor_token_type",
    "authorization_details",
    "client_assertion",
    "client_assertion_type",
    "client_id",
    "client_secret",
  ] as const)("rejects a non-empty unsupported %s", async (field) => {
    const fetchExternal = vi.fn<typeof fetch>();
    const observe = vi.fn(async () => undefined);
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: fetchExternal,
      now: () => testNow,
    });
    const response = await tokenExchange(formRequest({ [field]: "unsupported" }), { observe });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(observe).not.toHaveBeenCalled();
    expect(fetchExternal).not.toHaveBeenCalled();
  });

  it("ignores empty unsupported parameters before authenticating the Subject Token", async () => {
    const observe = vi.fn(async () => undefined);
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: vi.fn<typeof fetch>(),
      now: () => testNow,
    });
    const form = validForm();

    for (const field of [
      "actor_token",
      "actor_token_type",
      "authorization_details",
      "client_assertion",
      "client_assertion_type",
      "client_id",
      "client_secret",
    ]) {
      form.append(field, "");
    }

    const response = await tokenExchange(formRequest({}, form), { observe });

    expect(response.status).toBe(400);
    expect(observe).toHaveBeenCalledWith({
      fields: {
        diagnosticCode: "ERR_JWT_INVALID",
        path: "/token",
        reason: "invalid_token",
        userAgent: null,
      },
      level: "warn",
      message: "OIDC authentication failed",
    });
  });

  it("rejects duplicate non-empty singleton values and accepts surrounding empty values", async () => {
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: vi.fn<typeof fetch>(),
      now: () => testNow,
    });
    const rejectedForm = validForm();
    rejectedForm.append("scope", "contents:read");
    const rejectedObserve = vi.fn(async () => undefined);
    const rejected = await tokenExchange(formRequest({}, rejectedForm), {
      observe: rejectedObserve,
    });
    const acceptedForm = validForm();
    acceptedForm.append("scope", "");
    acceptedForm.append("resource", "");
    const acceptedObserve = vi.fn(async () => undefined);
    const accepted = await tokenExchange(formRequest({}, acceptedForm), {
      observe: acceptedObserve,
    });

    expect(rejected.status).toBe(400);
    expect(rejectedObserve).not.toHaveBeenCalled();
    expect(accepted.status).toBe(400);
    expect(acceptedObserve).toHaveBeenCalled();
  });

  it("accepts an empty singleton occurrence before its non-empty value", async () => {
    const observations: TokenExchangeObservation[] = [];
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: fetchExternal,
      now: () => testNow,
    });
    const validBody = new URLSearchParams(await tokenExchangeRequestBody());
    const form = new URLSearchParams([["grant_type", ""], ...validBody]);
    const response = await tokenExchange(
      new Request("https://broker.example/token", {
        body: form,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      {
        observe: async (observation) => {
          observations.push(observation);
        },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ access_token: "ghs_test_token" });
    expect(observations.map(({ fields }) => fields["event"])).toEqual([
      "installation_access_token_issuance_started",
      "installation_access_token_issuance_succeeded",
    ]);
  });

  it("rejects an oversized body before authentication", async () => {
    const observe = vi.fn(async () => undefined);
    const tokenExchange = createGitHubAppTokenExchange(configuration, {
      fetch: vi.fn<typeof fetch>(),
      now: () => testNow,
    });
    const response = await tokenExchange(
      new Request("https://broker.example/token", {
        body: `grant_type=x&subject_token=${"x".repeat(64 * 1024)}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      { observe },
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(observe).not.toHaveBeenCalled();
  });
});

function validForm(overrides: Record<string, string | null> = {}): URLSearchParams {
  const form = new URLSearchParams({
    grant_type: tokenExchangeGrantType,
    requested_token_type: accessTokenType,
    resource: "https://api.github.com/repos/fixture-owner/fixture-source-repository",
    scope: "contents:write pull_requests:write",
    subject_token: "not-a-jwt",
    subject_token_type: oidcIdTokenType,
  });

  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) {
      form.delete(key);
    } else {
      form.set(key, value);
    }
  }

  return form;
}

function formRequest(
  overrides: Record<string, string | null> = {},
  form: URLSearchParams = validForm(overrides),
): Request {
  return new Request("https://broker.example/token", {
    body: form,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
}
