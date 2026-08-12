import { describe, expect, it } from "vitest";

import {
  createOidcProviderRegistration,
  parseOidcIssuerIdentifier,
  snapshotOidcProviderRegistrations,
  type OidcIdTokenSigningAlgorithm,
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

  it.each([
    {
      acceptedIdTokenSigningAlgorithms: [],
      message: "invalid OIDC ID Token signing algorithm allowlist",
    },
    {
      acceptedIdTokenSigningAlgorithms: ["RS256", "RS256"],
      message: "invalid OIDC ID Token signing algorithm allowlist",
    },
    {
      acceptedIdTokenSigningAlgorithms: ["HS256"],
      message: "invalid OIDC ID Token signing algorithm allowlist",
    },
    {
      acceptedIdTokenSigningAlgorithms: ["RS256"],
      issuer: "not a URL",
      message: "invalid OIDC Issuer Identifier",
    },
  ] as const)(
    "rejects an invalid registration component",
    ({ acceptedIdTokenSigningAlgorithms, issuer = "https://issuer.example", message }) => {
      expect(() =>
        createOidcProviderRegistration({
          acceptedIdTokenSigningAlgorithms: acceptedIdTokenSigningAlgorithms as never,
          idTokenProfile: { validate: () => true },
          issuer,
        }),
      ).toThrow(message);
    },
  );

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
  });

  it("rejects an omitted OIDC ID Token Profile", () => {
    expect(() =>
      createOidcProviderRegistration({
        acceptedIdTokenSigningAlgorithms: ["RS256"],
        issuer: "https://issuer.example",
      } as never),
    ).toThrow("invalid OIDC ID Token Profile");
  });

  it("validates and snapshots a unique registration collection", () => {
    const acceptedIdTokenSigningAlgorithms: OidcIdTokenSigningAlgorithm[] = ["RS256"];
    const issuer = parseOidcIssuerIdentifier("https://issuer.example");

    if (issuer === null) {
      throw new Error("expected valid test issuer");
    }

    const input = {
      acceptedIdTokenSigningAlgorithms,
      idTokenProfile: null,
      issuer,
    };
    const snapshot = snapshotOidcProviderRegistrations([input]);

    acceptedIdTokenSigningAlgorithms.splice(0);

    expect(snapshot).toMatchObject([
      { acceptedIdTokenSigningAlgorithms: ["RS256"], issuer: "https://issuer.example" },
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(Object.isFrozen(snapshot[0]?.acceptedIdTokenSigningAlgorithms)).toBe(true);
    expect(snapshot[0]).not.toBe(input);
  });

  it("rejects duplicate issuers while snapshotting a registration collection", () => {
    const registration = createOidcProviderRegistration({
      acceptedIdTokenSigningAlgorithms: ["RS256"],
      idTokenProfile: null,
      issuer: "https://issuer.example",
    });

    expect(() => snapshotOidcProviderRegistrations([registration, registration])).toThrow(
      "duplicate OIDC Provider Registration issuer",
    );
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

  it.each([null, undefined, "registration", 1])(
    "rejects a malformed OIDC Provider Registration input: %j",
    (input) => {
      expect(() => createOidcProviderRegistration(input as never)).toThrow(
        "invalid OIDC Provider Registration",
      );
    },
  );
});
