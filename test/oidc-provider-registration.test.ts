import { describe, expect, it } from "vitest";

import {
  createOidcProviderRegistration,
  parseOidcIssuerIdentifier,
} from "@github-app-token-broker/oidc/provider-registration";

describe("OIDC Provider Registration", () => {
  it.each(["https://issuer.example", "https://issuer.example/", "https://issuer.example/tenant"])(
    "preserves an exact valid OIDC Issuer Identifier: %s",
    (issuer) => {
      expect(parseOidcIssuerIdentifier(issuer)).toBe(issuer);
    },
  );

  it.each([
    "",
    "issuer.example",
    "http://issuer.example",
    "https://issuer.example?query",
    "https://issuer.example#fragment",
    "https://user@issuer.example",
    " https://issuer.example",
  ])("rejects an invalid OIDC Issuer Identifier: %j", (issuer) => {
    expect(parseOidcIssuerIdentifier(issuer)).toBeNull();
  });

  it("rejects empty and duplicate per-provider algorithm allowlists", () => {
    const profile = { validate: () => true };

    expect(() =>
      createOidcProviderRegistration({
        acceptedIdTokenSigningAlgorithms: [],
        idTokenProfile: profile,
        issuer: "https://issuer.example",
      }),
    ).toThrow();
    expect(() =>
      createOidcProviderRegistration({
        acceptedIdTokenSigningAlgorithms: ["RS256", "RS256"],
        idTokenProfile: profile,
        issuer: "https://issuer.example",
      }),
    ).toThrow();
    expect(() =>
      createOidcProviderRegistration({
        acceptedIdTokenSigningAlgorithms: ["HS256" as never],
        idTokenProfile: profile,
        issuer: "https://issuer.example",
      }),
    ).toThrow();
    expect(() =>
      createOidcProviderRegistration({
        acceptedIdTokenSigningAlgorithms: ["RS256"],
        idTokenProfile: profile,
        issuer: "not a URL",
      }),
    ).toThrow();
  });

  it.each([undefined, "profile", 1, {}, { validate: null }])(
    "rejects a malformed OIDC ID Token Profile at construction: %j",
    (idTokenProfile) => {
      expect(() =>
        createOidcProviderRegistration({
          acceptedIdTokenSigningAlgorithms: ["RS256"],
          idTokenProfile: idTokenProfile as never,
          issuer: "https://issuer.example",
        }),
      ).toThrow("invalid OIDC ID Token Profile");
    },
  );

  it("accepts an explicitly null OIDC ID Token Profile", () => {
    const registration = createOidcProviderRegistration({
      acceptedIdTokenSigningAlgorithms: ["RS256"],
      idTokenProfile: null,
      issuer: "https://issuer.example",
    });

    expect(registration.idTokenProfile).toBeNull();
    expect(Object.isFrozen(registration)).toBe(true);
  });

  it("rejects an omitted OIDC ID Token Profile", () => {
    expect(() =>
      createOidcProviderRegistration({
        acceptedIdTokenSigningAlgorithms: ["RS256"],
        issuer: "https://issuer.example",
      } as never),
    ).toThrow("invalid OIDC ID Token Profile");
  });

  it("rejects inherited and accessor-backed OIDC ID Token Profiles without invoking accessors", () => {
    const inherited = Object.assign(Object.create({ idTokenProfile: null }), {
      acceptedIdTokenSigningAlgorithms: ["RS256"],
      issuer: "https://issuer.example",
    });
    let accessorInvoked = false;
    const accessorBacked = Object.defineProperty(
      {
        acceptedIdTokenSigningAlgorithms: ["RS256"],
        issuer: "https://issuer.example",
      },
      "idTokenProfile",
      {
        get() {
          accessorInvoked = true;
          return null;
        },
      },
    );

    expect(() => createOidcProviderRegistration(inherited)).toThrow(
      "invalid OIDC ID Token Profile",
    );
    expect(() => createOidcProviderRegistration(accessorBacked as never)).toThrow(
      "invalid OIDC ID Token Profile",
    );
    expect(accessorInvoked).toBe(false);
  });

  it("returns an immutable registration with an immutable validated profile", () => {
    const registration = createOidcProviderRegistration({
      acceptedIdTokenSigningAlgorithms: ["RS256"],
      idTokenProfile: { validate: () => true },
      issuer: "https://issuer.example",
    });

    expect(Object.isFrozen(registration)).toBe(true);
    expect(Object.isFrozen(registration.acceptedIdTokenSigningAlgorithms)).toBe(true);
    expect(Object.isFrozen(registration.idTokenProfile)).toBe(true);
  });

  it.each([null, undefined, "registration", 1])(
    "rejects a malformed OIDC Provider Registration input: %j",
    (input) => {
      expect(() => createOidcProviderRegistration(input as never)).toThrow(
        "invalid OIDC Provider Registration",
      );
    },
  );
});
