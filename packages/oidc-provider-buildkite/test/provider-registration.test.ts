import { describe, expect, it } from "vitest";

import { buildkiteOidcProviderRegistration } from "../src/provider-registration.ts";

describe("Buildkite OIDC Provider Registration", () => {
  it("registers the exact issuer with RS256 and no contextual authentication profile", () => {
    expect(buildkiteOidcProviderRegistration).toEqual({
      issuer: "https://agent.buildkite.com",
      acceptedIdTokenSigningAlgorithms: ["RS256"],
      idTokenProfile: null,
    });
  });
});
