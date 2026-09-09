import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { buildkiteOidcProviderRegistration } from "@github-app-token-broker/oidc-provider-buildkite";
import { githubActionsOidcProviderRegistration } from "@github-app-token-broker/oidc-provider-github-actions";
import { createFlyOidcProviderRegistration } from "../packages/oidc-provider-fly/src/provider-registration.ts";
import { googleServiceAccountOidcProviderRegistration } from "../packages/oidc-provider-google-service-account/src/provider-registration.ts";
import { createOidcIdTokenAuthenticator } from "@github-app-token-broker/oidc/id-token-authenticator";
import type { OidcProviderRegistration } from "@github-app-token-broker/oidc/provider-registration";
import { parseSubjectTokenAudience } from "@github-app-token-broker/oidc/subject-token-audience";
import { signRs256Jwt } from "./support/jwt.ts";
import { testNow } from "./support/constants.ts";

interface ProviderFixture {
  registration: OidcProviderRegistration;
  discoveryUrl: string;
  jwksUrl: string;
  payload: Record<string, unknown> & { iss: string };
}

// Payloads and URLs are independent literals, not derived from registrations.
const providers: ProviderFixture[] = [
  {
    registration: githubActionsOidcProviderRegistration,
    discoveryUrl: "https://token.actions.githubusercontent.com/.well-known/openid-configuration",
    jwksUrl: "https://token.actions.githubusercontent.com/.well-known/jwks",
    payload: {
      iss: "https://token.actions.githubusercontent.com",
      sub: "repo:example/source:ref:refs/heads/main",
      aud: "https://broker.example",
      azp: "https://broker.example",
      iat: 1779580790,
      exp: 1779581100,
      repository: "example/source",
    },
  },
  {
    registration: googleServiceAccountOidcProviderRegistration,
    discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
    jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
    payload: {
      iss: "https://accounts.google.com",
      sub: "107517467455664443765",
      azp: "107517467455664443765",
      aud: "https://broker.example",
      iat: 1779580790,
      exp: 1779581100,
      email: "example@example-project.iam.gserviceaccount.com",
      email_verified: true,
    },
  },
  {
    registration: createFlyOidcProviderRegistration("example-org"),
    discoveryUrl: "https://oidc.fly.io/example-org/.well-known/openid-configuration",
    jwksUrl: "https://oidc.fly.io/example-org/.well-known/jwks",
    payload: {
      iss: "https://oidc.fly.io/example-org",
      sub: "custom-machine-subject",
      azp: "unselected-authorized-party",
      aud: "https://broker.example",
      iat: 1779580790,
      exp: 1779581100,
      org_name: "different-org",
      app_name: "selected-app",
      machine_name: null,
    },
  },
  {
    registration: buildkiteOidcProviderRegistration,
    discoveryUrl: "https://agent.buildkite.com/.well-known/openid-configuration",
    jwksUrl: "https://agent.buildkite.com/.well-known/jwks",
    payload: {
      iss: "https://agent.buildkite.com",
      sub: "custom-job-subject",
      azp: "unselected-authorized-party",
      aud: "https://broker.example",
      iat: 1779580790,
      exp: 1779581100,
      organization_slug: "example",
      pipeline_slug: "release",
      step_key: null,
    },
  },
  {
    registration: createFlyOidcProviderRegistration("other-org"),
    discoveryUrl: "https://oidc.fly.io/other-org/.well-known/openid-configuration",
    jwksUrl: "https://oidc.fly.io/other-org/.well-known/jwks",
    payload: {
      iss: "https://oidc.fly.io/other-org",
      sub: "another-machine-subject",
      aud: "https://broker.example",
      iat: 1779580790,
      exp: 1779581100,
      org_name: "other-org",
      app_name: "other-app",
    },
  },
];

// Distinct keys intentionally reuse one kid, including both path-scoped Fly issuers.
const signingKeys = new Map(
  providers.map(({ payload }) => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    return [
      payload.iss,
      {
        privateKeyPem: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        jwk: {
          ...pair.publicKey.export({ format: "jwk" }),
          alg: "RS256",
          kid: "shared-key-id",
          use: "sig",
        },
      },
    ];
  }),
);

function fixture() {
  const requests: string[] = [];
  const authenticator = createOidcIdTokenAuthenticator(
    {
      providerRegistrations: providers.map(({ registration }) => registration),
      subjectTokenAudience: parseSubjectTokenAudience("https://broker.example"),
    },
    {
      now: () => testNow,
      fetch: async (input) => {
        const request = new Request(input);
        requests.push(request.url);
        const headers = { "cache-control": "max-age=300" };
        for (const provider of providers) {
          if (request.url === provider.discoveryUrl)
            return Response.json(
              {
                issuer: provider.payload.iss,
                jwks_uri: provider.jwksUrl,
                id_token_signing_alg_values_supported: ["RS256"],
              },
              { headers },
            );
          if (request.url === provider.jwksUrl)
            return Response.json(
              {
                keys: [signingKeys.get(provider.payload.iss)?.jwk],
              },
              { headers },
            );
        }
        throw new Error(`unexpected OIDC fixture URL: ${request.url}`);
      },
    },
  );
  return { authenticator, requests };
}

async function signWithIssuerKey(
  payload: Record<string, unknown>,
  signingKeyIssuer: string,
): Promise<string> {
  const key = signingKeys.get(signingKeyIssuer);
  if (key === undefined) throw new Error("expected fixture signing key");
  return signRs256Jwt(key.privateKeyPem, payload, "shared-key-id");
}

function providerFor(issuer: string): ProviderFixture {
  const provider = providers.find(({ payload }) => payload.iss === issuer);
  if (provider === undefined) throw new Error("expected provider fixture");
  return provider;
}

describe("Supported OIDC Provider conformance", () => {
  it("preserves each provider's signed claims and separately caches its exact discovery and keys", async () => {
    const { authenticator, requests } = fixture();
    for (const temperature of ["cold", "warm"]) {
      for (const provider of providers) {
        const token = await signWithIssuerKey(provider.payload, provider.payload.iss);
        const result = await authenticator.authenticateIdToken(token);
        expect(result, `${temperature}: ${provider.payload.iss}`).toMatchObject({ ok: true });
        if (!result.ok) throw new Error("expected successful provider authentication");
        expect(result.verifiedSubjectToken).toEqual({
          issuer: provider.payload.iss,
          claims: provider.payload,
        });
      }
    }
    expect(requests).toEqual(
      providers.flatMap(({ discoveryUrl, jwksUrl }) => [discoveryUrl, jwksUrl]),
    );
  });

  it("does not reuse one Fly organization's same-kid key for another organization", async () => {
    const { authenticator, requests } = fixture();
    const first = providerFor("https://oidc.fly.io/example-org");
    const second = providerFor("https://oidc.fly.io/other-org");
    expect(
      await authenticator.authenticateIdToken(
        await signWithIssuerKey(first.payload, first.payload.iss),
      ),
    ).toMatchObject({ ok: true });
    expect(
      await authenticator.authenticateIdToken(
        await signWithIssuerKey(second.payload, first.payload.iss),
      ),
    ).toMatchObject({
      ok: false,
      failure: { kind: "subject_token_rejected" },
    });
    expect(requests).toEqual([
      first.discoveryUrl,
      first.jwksUrl,
      second.discoveryUrl,
      second.jwksUrl,
    ]);
  });

  it("accepts GitHub Actions without azp", async () => {
    const { authenticator } = fixture();
    const provider = providerFor("https://token.actions.githubusercontent.com");
    const { azp: _azp, ...payload } = provider.payload;
    expect(
      await authenticator.authenticateIdToken(
        await signWithIssuerKey(payload, provider.payload.iss),
      ),
    ).toMatchObject({ ok: true });
  });

  it.each([
    { issuer: "https://token.actions.githubusercontent.com", azp: "wrong-audience" },
    { issuer: "https://accounts.google.com", azp: undefined },
    { issuer: "https://accounts.google.com", azp: "https://broker.example" },
  ])("rejects Claims that violate the selected ID Token profile: %j", async ({ issuer, azp }) => {
    const { authenticator, requests } = fixture();
    const provider = providerFor(issuer);
    const token = await signWithIssuerKey({ ...provider.payload, azp }, issuer);
    expect(await authenticator.authenticateIdToken(token)).toMatchObject({
      ok: false,
      failure: { kind: "subject_token_rejected" },
    });
    expect(requests).toEqual([provider.discoveryUrl, provider.jwksUrl]);
  });
});
