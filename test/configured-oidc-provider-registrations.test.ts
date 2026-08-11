import { describe, expect, it } from "vitest";

import {
  configuredOidcProviderRegistrations,
  githubActionsOidcProviderRegistration,
  googleServiceAccountOidcProviderRegistration,
} from "../workers/github-app-token-broker/src/configured-oidc-provider-registrations.ts";

describe("configured OIDC Provider Registrations", () => {
  it("contains exactly the checked-in GitHub Actions and Google registrations", () => {
    expect(configuredOidcProviderRegistrations).toEqual([
      githubActionsOidcProviderRegistration,
      googleServiceAccountOidcProviderRegistration,
    ]);
    expect(Object.isFrozen(configuredOidcProviderRegistrations)).toBe(true);
  });
});
