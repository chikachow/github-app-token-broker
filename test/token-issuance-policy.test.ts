import { describe, expect, it } from "vitest";

import {
  createOidcProviderRegistration,
  parseOidcIssuerIdentifier,
} from "@github-app-token-broker/oidc/provider-registration";
import {
  createGitHubRepositoryResource,
  installationAccessTokenPermissionLevelCovers,
  unionGitHubInstallationPermissions,
  type GitHubInstallationPermissions,
  type InstallationAccessTokenRequest,
} from "../workers/github-app-token-broker/src/installation-access-token-request.ts";
import {
  claimEquals,
  claimOneOf,
  compileTokenIssuancePolicy,
  githubRepositoryResourceConstraint,
  oidcSubjectTokenConstraint,
  assertTokenIssuancePolicyIssuersAreRegistered,
  tokenIssuancePolicyPermits,
  tokenIssuancePolicySupportsRequestedPermissions,
  tokenIssuancePolicySupportsTarget,
  type PermitStatementDefinition,
} from "../workers/github-app-token-broker/src/policy/token-issuance-policy.ts";
import type { VerifiedSubjectToken } from "../workers/github-app-token-broker/src/authentication.ts";
import { createVerifiedSubjectToken } from "./support/oidc.ts";

const parsedIssuer = parseOidcIssuerIdentifier("https://issuer.example");

if (parsedIssuer === null) {
  throw new Error("invalid test OIDC Issuer Identifier");
}

const issuer = parsedIssuer;

function validPermitStatement(): PermitStatementDefinition {
  return {
    permissions: { contents: "write" },
    resource: githubRepositoryResourceConstraint("owner", "repository"),
    subjectToken: oidcSubjectTokenConstraint(
      issuer,
      claimEquals("repository", "owner/source"),
      claimEquals("trusted", true),
      claimOneOf("event_name", ["push", "workflow_dispatch"]),
    ),
  };
}

describe("Token Issuance Policy authoring factories", () => {
  it("creates recursively immutable definitions", () => {
    const equals = claimEquals("trusted", true);
    const oneOf = claimOneOf("event_name", ["push", "workflow_dispatch"]);
    const subjectToken = oidcSubjectTokenConstraint(issuer, equals, oneOf);
    const resource = githubRepositoryResourceConstraint("Owner.Name", "Repository_Name");

    if (oneOf.kind !== "claim-one-of") {
      throw new Error("unexpected Claim predicate kind");
    }

    expect(equals).toEqual({ claimName: "trusted", expectedValue: true, kind: "claim-equals" });
    expect(oneOf).toEqual({
      claimName: "event_name",
      expectedValues: ["push", "workflow_dispatch"],
      kind: "claim-one-of",
    });
    expect(subjectToken).toEqual({ claimPredicates: [equals, oneOf], issuer });
    expect(resource).toEqual({ owner: "Owner.Name", repository: "Repository_Name" });
    expect(Object.isFrozen(equals)).toBe(true);
    expect(Object.isFrozen(oneOf)).toBe(true);
    expect(Object.isFrozen(oneOf.expectedValues)).toBe(true);
    expect(Object.isFrozen(subjectToken)).toBe(true);
    expect(Object.isFrozen(subjectToken.claimPredicates)).toBe(true);
    expect(Object.isFrozen(resource)).toBe(true);
  });

  it("accepts issuer-only constraints and unusual Claim Names", () => {
    expect(oidcSubjectTokenConstraint(issuer)).toEqual({ claimPredicates: [], issuer });
    expect(claimEquals("", "value")).toEqual({
      claimName: "",
      expectedValue: "value",
      kind: "claim-equals",
    });
    expect(claimEquals("__proto__", false)).toEqual({
      claimName: "__proto__",
      expectedValue: false,
      kind: "claim-equals",
    });
  });

  it.each([
    () => claimEquals(null as never, "value"),
    () => claimEquals("claim", 1 as never),
    () => claimOneOf(null as never, ["value"]),
    () => claimOneOf("claim", []),
    () => claimOneOf("claim", ["duplicate", "duplicate"]),
    () => claimOneOf("claim", ["valid", true as never]),
    () => oidcSubjectTokenConstraint("not an issuer" as never),
    () => oidcSubjectTokenConstraint(null as never),
    () =>
      oidcSubjectTokenConstraint(
        issuer,
        claimEquals("claim", "first"),
        claimOneOf("claim", ["second"]),
      ),
    () => githubRepositoryResourceConstraint(".", "repository"),
    () => githubRepositoryResourceConstraint("owner", ".."),
  ])("rejects malformed factory input", (construct) => {
    expect(construct).toThrow(TypeError);
  });
});

describe("Token Issuance Policy compilation", () => {
  it("accepts empty, duplicate, and overlapping Permit Statements", () => {
    const statement = validPermitStatement();
    const overlapping: PermitStatementDefinition = {
      ...statement,
      permissions: { actions: "read" },
    };

    expect(Object.isFrozen(compileTokenIssuancePolicy([]))).toBe(true);
    expect(() => compileTokenIssuancePolicy([statement, statement, overlapping])).not.toThrow();
  });

  it("defensively compiles structurally authored definitions", () => {
    const statement = {
      permissions: { actions: "read", contents: "write" },
      resource: { owner: "owner", repository: "repository" },
      subjectToken: {
        claimPredicates: [
          { claimName: "trusted", expectedValue: true, kind: "claim-equals" },
          {
            claimName: "event_name",
            expectedValues: ["push", "workflow_dispatch"],
            kind: "claim-one-of",
          },
        ],
        issuer,
      },
    } as const;

    expect(Object.isFrozen(compileTokenIssuancePolicy([statement]))).toBe(true);
  });

  it.each([
    [null, "permitStatements must be an array"],
    [[null], "permitStatements[0] must be an object"],
    [[{ ...validPermitStatement(), unknown: true }], "permitStatements[0].unknown"],
    [
      [
        {
          ...validPermitStatement(),
          subjectToken: { ...validPermitStatement().subjectToken, issuer: "not an issuer" },
        },
      ],
      "permitStatements[0].subjectToken.issuer",
    ],
    [
      [
        {
          ...validPermitStatement(),
          subjectToken: { ...validPermitStatement().subjectToken, issuer: null },
        },
      ],
      "permitStatements[0].subjectToken.issuer",
    ],
    [
      [
        {
          ...validPermitStatement(),
          subjectToken: {
            ...validPermitStatement().subjectToken,
            claimPredicates: [{ claimName: "claim", expectedValue: 1, kind: "claim-equals" }],
          },
        },
      ],
      "permitStatements[0].subjectToken.claimPredicates[0].expectedValue",
    ],
    [
      [
        {
          ...validPermitStatement(),
          subjectToken: {
            ...validPermitStatement().subjectToken,
            claimPredicates: [{ claimName: null, expectedValue: true, kind: "claim-equals" }],
          },
        },
      ],
      "permitStatements[0].subjectToken.claimPredicates[0].claimName",
    ],
    [
      [
        {
          ...validPermitStatement(),
          subjectToken: {
            ...validPermitStatement().subjectToken,
            claimPredicates: [
              { claimName: "claim", expectedValue: true, kind: "claim-equals" },
              { claimName: "claim", expectedValues: ["value"], kind: "claim-one-of" },
            ],
          },
        },
      ],
      'permitStatements[0].subjectToken.claimPredicates[1] repeats Claim Name "claim"',
    ],
    [
      [
        {
          ...validPermitStatement(),
          subjectToken: {
            ...validPermitStatement().subjectToken,
            claimPredicates: [{ claimName: "claim", expectedValues: [], kind: "claim-one-of" }],
          },
        },
      ],
      "permitStatements[0].subjectToken.claimPredicates[0].expectedValues must not be empty",
    ],
    [
      [
        {
          ...validPermitStatement(),
          subjectToken: {
            ...validPermitStatement().subjectToken,
            claimPredicates: [
              {
                claimName: "claim",
                expectedValues: ["duplicate", "duplicate"],
                kind: "claim-one-of",
              },
            ],
          },
        },
      ],
      "permitStatements[0].subjectToken.claimPredicates[0].expectedValues must not contain duplicates",
    ],
    [
      [
        {
          ...validPermitStatement(),
          subjectToken: {
            ...validPermitStatement().subjectToken,
            claimPredicates: [
              { claimName: "claim", expectedValues: ["value", false], kind: "claim-one-of" },
            ],
          },
        },
      ],
      "permitStatements[0].subjectToken.claimPredicates[0].expectedValues must contain only strings",
    ],
    [
      [{ ...validPermitStatement(), resource: { owner: null, repository: "repository" } }],
      "permitStatements[0].resource.owner",
    ],
    [
      [{ ...validPermitStatement(), resource: { owner: "owner", repository: null } }],
      "permitStatements[0].resource.repository",
    ],
    [
      [{ ...validPermitStatement(), resource: { owner: ".", repository: "repository" } }],
      "permitStatements[0].resource",
    ],
    [[{ ...validPermitStatement(), permissions: {} }], "permitStatements[0].permissions"],
    [
      [{ ...validPermitStatement(), permissions: { contents: "maintain" } }],
      "permitStatements[0].permissions.contents",
    ],
  ] as const)("rejects malformed structure at its source path", (definitions, path) => {
    expect(() => compileTokenIssuancePolicy(definitions as never)).toThrow(path);
  });

  it("rejects unknown nested fields", () => {
    const statement = validPermitStatement();

    expect(() =>
      compileTokenIssuancePolicy([
        {
          ...statement,
          resource: { ...statement.resource, kind: "github-repository" },
        } as never,
      ]),
    ).toThrow("permitStatements[0].resource.kind");
    expect(() =>
      compileTokenIssuancePolicy([
        {
          ...statement,
          subjectToken: {
            ...statement.subjectToken,
            claimPredicates: [{ ...claimEquals("claim", "value"), unknown: true } as never],
          },
        },
      ]),
    ).toThrow("permitStatements[0].subjectToken.claimPredicates[0].unknown");
  });

  it("rejects missing and malformed predicate discriminants", () => {
    const statement = validPermitStatement();

    for (const [predicate, expectedPath] of [
      [{ claimName: "claim", expectedValue: true }, ".kind must be an own data field"],
      [
        { claimName: "claim", expectedValue: true, kind: 1 },
        ".kind has an unsupported discriminant",
      ],
      [
        { claimName: "claim", expectedValue: true, kind: "unsupported" },
        ".kind has an unsupported discriminant",
      ],
    ] as const) {
      expect(() =>
        compileTokenIssuancePolicy([
          {
            ...statement,
            subjectToken: { ...statement.subjectToken, claimPredicates: [predicate] },
          } as never,
        ]),
      ).toThrow(`permitStatements[0].subjectToken.claimPredicates[0]${expectedPath}`);
    }
  });

  it("rejects missing, accessor-backed, and symbol-bearing structural fields", () => {
    const statement = validPermitStatement();
    const missingSubjectToken = {
      permissions: statement.permissions,
      resource: statement.resource,
    };
    const accessorSubjectToken = Object.defineProperty(
      {
        permissions: statement.permissions,
        resource: statement.resource,
      },
      "subjectToken",
      { enumerable: true, get: () => statement.subjectToken },
    );
    const accessorKind = Object.defineProperty(
      { claimName: "claim", expectedValue: true },
      "kind",
      { enumerable: true, get: () => "claim-equals" },
    );
    const symbolStatement = { ...statement, [Symbol("unknown")]: true };
    const symbolStatements = [statement];
    Object.defineProperty(symbolStatements, Symbol("unknown"), { value: true });

    expect(() => compileTokenIssuancePolicy([missingSubjectToken as never])).toThrow(
      "permitStatements[0].subjectToken is required",
    );
    expect(() => compileTokenIssuancePolicy([accessorSubjectToken as never])).toThrow(
      "permitStatements[0].subjectToken must be an own data field",
    );
    expect(() =>
      compileTokenIssuancePolicy([
        {
          ...statement,
          subjectToken: { ...statement.subjectToken, claimPredicates: [accessorKind] },
        } as never,
      ]),
    ).toThrow("permitStatements[0].subjectToken.claimPredicates[0].kind must be an own data field");
    expect(() => compileTokenIssuancePolicy([symbolStatement])).toThrow(
      "permitStatements[0] must not contain symbol fields",
    );
    expect(() => compileTokenIssuancePolicy(symbolStatements)).toThrow(
      "permitStatements must not contain symbol fields",
    );
  });

  it("rejects accessors without invoking them", () => {
    let invoked = false;
    const statement = validPermitStatement();
    const permissions = Object.defineProperty({}, "contents", {
      enumerable: true,
      get() {
        invoked = true;
        return "write";
      },
    });

    expect(() => compileTokenIssuancePolicy([{ ...statement, permissions } as never])).toThrow(
      "permitStatements[0].permissions.contents must be an own data field",
    );
    expect(invoked).toBe(false);
  });

  it("rejects inherited definition fields", () => {
    const statement = Object.assign(Object.create({ permissions: { contents: "write" } }), {
      resource: githubRepositoryResourceConstraint("owner", "repository"),
      subjectToken: oidcSubjectTokenConstraint(issuer),
    });

    expect(() => compileTokenIssuancePolicy([statement])).toThrow(
      "permitStatements[0] must not contain inherited fields",
    );
  });

  it("rejects sparse and accessor-backed arrays", () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    const accessor = Object.defineProperty([], "0", {
      configurable: true,
      enumerable: true,
      get: () => validPermitStatement(),
    });
    Object.defineProperty(accessor, "length", { value: 1 });

    expect(() => compileTokenIssuancePolicy(sparse as never)).toThrow(
      "permitStatements[0] must be an own data element",
    );
    expect(() => compileTokenIssuancePolicy(accessor)).toThrow(
      "permitStatements[0] must be an own data element",
    );
  });

  it("rejects unknown own array fields, including numeric-looking non-index fields", () => {
    const withNamedField = Object.assign([], { unexpected: true });
    const withNumericLookingField: unknown[] = [];
    Object.defineProperty(withNumericLookingField, "4294967295", {
      enumerable: true,
      value: validPermitStatement(),
    });

    expect(() => compileTokenIssuancePolicy(withNamedField as never)).toThrow(
      "permitStatements.unexpected is an unknown array field",
    );
    expect(() => compileTokenIssuancePolicy(withNumericLookingField as never)).toThrow(
      "permitStatements.4294967295 is an unknown array field",
    );
  });
});

const permissionNames = ["future_permission", "issues"] as const;
const permissionLevels = [undefined, "read", "write", "admin"] as const;
const allPermissionMaps = permissionLevels.flatMap((futurePermission) =>
  permissionLevels.map((issues) =>
    Object.freeze({
      ...(futurePermission === undefined ? {} : { future_permission: futurePermission }),
      ...(issues === undefined ? {} : { issues }),
    }),
  ),
);
const nonEmptyPermissionMaps = allPermissionMaps.filter(
  (permissions) => Object.keys(permissions).length > 0,
);
const repositoryResource = createGitHubRepositoryResource({
  owner: "owner",
  repository: "repository",
});
const matchingSubjectToken = createVerifiedSubjectToken(
  { branch: "main", environment: "production", trusted: true },
  { issuer },
);

function requestFor(
  permissions: GitHubInstallationPermissions,
  resource = repositoryResource,
): InstallationAccessTokenRequest {
  return { permissions, resource, scope: "test-scope" };
}

function statementFor(
  permissions: GitHubInstallationPermissions,
  overrides: Partial<PermitStatementDefinition> = {},
): PermitStatementDefinition {
  return {
    permissions,
    resource: githubRepositoryResourceConstraint("owner", "repository"),
    subjectToken: oidcSubjectTokenConstraint(issuer),
    ...overrides,
  };
}

function policyForContributions(...contributions: readonly GitHubInstallationPermissions[]) {
  return compileTokenIssuancePolicy(
    contributions
      .filter((permissions) => Object.keys(permissions).length > 0)
      .map((permissions) => statementFor(permissions)),
  );
}

function materializedPermissionsCover(
  configured: GitHubInstallationPermissions,
  requested: GitHubInstallationPermissions,
): boolean {
  return permissionNames.every((name) => {
    const requestedLevel = requested[name];

    return (
      requestedLevel === undefined ||
      installationAccessTokenPermissionLevelCovers(configured[name], requestedLevel)
    );
  });
}

describe("Token Issuance Policy evaluation", () => {
  it("rejects values that are not compiled policies", () => {
    expect(() =>
      tokenIssuancePolicyPermits(
        {} as never,
        matchingSubjectToken,
        requestFor({ contents: "read" }),
      ),
    ).toThrow("invalid Token Issuance Policy");
    expect(() =>
      tokenIssuancePolicySupportsTarget({} as never, requestFor({ contents: "read" })),
    ).toThrow("invalid Token Issuance Policy");
    expect(() =>
      tokenIssuancePolicySupportsRequestedPermissions(
        {} as never,
        requestFor({ contents: "read" }),
      ),
    ).toThrow("invalid Token Issuance Policy");
    expect(() => assertTokenIssuancePolicyIssuersAreRegistered({} as never, [])).toThrow(
      "invalid Token Issuance Policy",
    );
  });

  it("reports every unique missing policy issuer in lexical order", () => {
    const firstIssuer = parseOidcIssuerIdentifier("https://a.example");
    const secondIssuer = parseOidcIssuerIdentifier("https://z.example");

    if (firstIssuer === null || secondIssuer === null) {
      throw new Error("invalid issuer-coverage test fixture");
    }

    const policy = compileTokenIssuancePolicy([
      statementFor(
        { contents: "read" },
        { subjectToken: oidcSubjectTokenConstraint(secondIssuer) },
      ),
      statementFor({ actions: "read" }, { subjectToken: oidcSubjectTokenConstraint(firstIssuer) }),
      statementFor(
        { pull_requests: "read" },
        { subjectToken: oidcSubjectTokenConstraint(secondIssuer) },
      ),
    ]);

    expect(() => assertTokenIssuancePolicyIssuersAreRegistered(policy, [])).toThrow(
      "https://a.example, https://z.example",
    );
  });

  it("accepts policy issuer subsets and unused registrations", () => {
    const registration = createOidcProviderRegistration({
      acceptedIdTokenSigningAlgorithms: ["RS256"],
      idTokenProfile: { validate: () => true },
      issuer,
    });
    const unusedRegistration = createOidcProviderRegistration({
      acceptedIdTokenSigningAlgorithms: ["RS256"],
      idTokenProfile: { validate: () => true },
      issuer: "https://unused.example",
    });

    expect(() =>
      assertTokenIssuancePolicyIssuersAreRegistered(
        compileTokenIssuancePolicy([statementFor({ contents: "read" })]),
        [registration, unusedRegistration],
      ),
    ).not.toThrow();
  });

  it("matches strict own string and Boolean Claim predicates", () => {
    const policy = compileTokenIssuancePolicy([
      statementFor(
        { contents: "read" },
        {
          subjectToken: oidcSubjectTokenConstraint(
            issuer,
            claimEquals("trusted", true),
            claimOneOf("environment", ["production", "staging"]),
          ),
        },
      ),
    ]);

    expect(
      tokenIssuancePolicyPermits(policy, matchingSubjectToken, requestFor({ contents: "read" })),
    ).toBe(true);

    for (const claims of [
      { environment: "production", trusted: "true" },
      { environment: true, trusted: true },
      { environment: ["production"], trusted: true },
      { environment: null, trusted: true },
      { environment: "development", trusted: true },
      { environment: "production" },
    ]) {
      expect(
        tokenIssuancePolicyPermits(
          policy,
          createVerifiedSubjectToken(claims, { issuer }),
          requestFor({ contents: "read" }),
        ),
      ).toBe(false);
    }
  });

  it("requires selected Claims to be own properties, including unusual names", () => {
    const policy = compileTokenIssuancePolicy([
      statementFor(
        { contents: "read" },
        {
          subjectToken: oidcSubjectTokenConstraint(
            issuer,
            claimEquals("inherited", "value"),
            claimEquals("__proto__", "literal"),
          ),
        },
      ),
    ]);
    const inheritedClaims = Object.assign(Object.create({ inherited: "value" }), {
      __proto__: "literal",
    });
    const ownClaims = Object.create(null) as Record<string, unknown>;
    ownClaims["inherited"] = "value";
    ownClaims["__proto__"] = "literal";

    expect(
      tokenIssuancePolicyPermits(
        policy,
        { claims: inheritedClaims, issuer } as VerifiedSubjectToken,
        requestFor({ contents: "read" }),
      ),
    ).toBe(false);
    expect(
      tokenIssuancePolicyPermits(
        policy,
        { claims: ownClaims, issuer } as VerifiedSubjectToken,
        requestFor({ contents: "read" }),
      ),
    ).toBe(true);
  });

  it("combines broad and narrow applicable statements", () => {
    const policy = compileTokenIssuancePolicy([
      statementFor({ contents: "write" }),
      statementFor(
        { actions: "read" },
        {
          subjectToken: oidcSubjectTokenConstraint(issuer, claimEquals("branch", "main")),
        },
      ),
    ]);

    expect(
      tokenIssuancePolicyPermits(
        policy,
        matchingSubjectToken,
        requestFor({ actions: "read", contents: "read" }),
      ),
    ).toBe(true);
  });

  it("permits arbitrary permission names only when statements cover their requested levels", () => {
    const policy = compileTokenIssuancePolicy([
      statementFor({ future_permission: "admin", issues: "write" }),
    ]);

    expect(
      tokenIssuancePolicyPermits(
        policy,
        matchingSubjectToken,
        requestFor({ future_permission: "admin", issues: "read" }),
      ),
    ).toBe(true);
    expect(
      tokenIssuancePolicyPermits(
        policy,
        matchingSubjectToken,
        requestFor({ another_permission: "read" }),
      ),
    ).toBe(false);
  });

  it("does not combine partial issuer, Claim, or resource matches", () => {
    const otherIssuer = parseOidcIssuerIdentifier("https://other-issuer.example");

    if (otherIssuer === null) {
      throw new Error("invalid other test issuer");
    }

    const policy = compileTokenIssuancePolicy([
      statementFor({ actions: "write" }, { subjectToken: oidcSubjectTokenConstraint(otherIssuer) }),
      statementFor(
        { contents: "write" },
        {
          subjectToken: oidcSubjectTokenConstraint(issuer, claimEquals("branch", "other")),
        },
      ),
      statementFor(
        { pull_requests: "write" },
        { resource: githubRepositoryResourceConstraint("owner", "other-repository") },
      ),
    ]);

    expect(
      tokenIssuancePolicyPermits(
        policy,
        matchingSubjectToken,
        requestFor({ actions: "read", contents: "read", pull_requests: "read" }),
      ),
    ).toBe(false);
  });

  it("classifies target support without treating it as authorization", () => {
    const otherIssuer = parseOidcIssuerIdentifier("https://other-issuer.example");

    if (otherIssuer === null) {
      throw new Error("invalid other test issuer");
    }

    const policy = compileTokenIssuancePolicy([
      statementFor(
        { contents: "write" },
        { subjectToken: oidcSubjectTokenConstraint(otherIssuer) },
      ),
      statementFor(
        { actions: "read" },
        {
          subjectToken: oidcSubjectTokenConstraint(issuer, claimEquals("branch", "other")),
        },
      ),
    ]);
    const supportedTarget = requestFor({ actions: "read", contents: "read" });

    expect(tokenIssuancePolicySupportsTarget(policy, supportedTarget)).toBe(true);
    expect(tokenIssuancePolicySupportsRequestedPermissions(policy, supportedTarget)).toBe(true);
    expect(tokenIssuancePolicyPermits(policy, matchingSubjectToken, supportedTarget)).toBe(false);
    expect(
      tokenIssuancePolicySupportsTarget(
        policy,
        requestFor(
          { contents: "read" },
          createGitHubRepositoryResource({ owner: "other", repository: "repository" }),
        ),
      ),
    ).toBe(false);
    expect(tokenIssuancePolicySupportsTarget(policy, requestFor({ actions: "write" }))).toBe(true);
    expect(
      tokenIssuancePolicySupportsRequestedPermissions(policy, requestFor({ actions: "write" })),
    ).toBe(false);
  });

  it("is neutral to statement order, duplicates, and split or merged definitions", () => {
    const contents = statementFor({ contents: "write" });
    const actions = statementFor({ actions: "read" });
    const merged = statementFor({ actions: "read", contents: "write" });
    const request = requestFor({ actions: "read", contents: "read" });
    const policies = [
      compileTokenIssuancePolicy([contents, actions]),
      compileTokenIssuancePolicy([actions, contents]),
      compileTokenIssuancePolicy([contents, actions, contents, actions]),
      compileTokenIssuancePolicy([merged]),
    ];

    expect(
      policies.map((policy) => tokenIssuancePolicyPermits(policy, matchingSubjectToken, request)),
    ).toEqual([true, true, true, true]);
  });

  it("copies compiled input before evaluation", () => {
    const permissions = { contents: "read" } as { contents: "read" | "write" };
    const expectedValues = ["production"];
    const statement = {
      permissions,
      resource: { owner: "owner", repository: "repository" },
      subjectToken: {
        claimPredicates: [
          { claimName: "environment", expectedValues, kind: "claim-one-of" as const },
        ],
        issuer,
      },
    };
    const policy = compileTokenIssuancePolicy([statement as never]);

    permissions.contents = "write";
    expectedValues[0] = "development";
    statement.resource.repository = "other-repository";

    expect(
      tokenIssuancePolicyPermits(policy, matchingSubjectToken, requestFor({ contents: "read" })),
    ).toBe(true);
    expect(
      tokenIssuancePolicyPermits(policy, matchingSubjectToken, requestFor({ contents: "write" })),
    ).toBe(false);
  });

  it("does not permit any request with an empty policy", () => {
    expect(
      tokenIssuancePolicyPermits(
        compileTokenIssuancePolicy([]),
        matchingSubjectToken,
        requestFor({ contents: "read" }),
      ),
    ).toBe(false);
  });

  it("is equivalent to materialized pointwise union across the complete level lattice", () => {
    let cases = 0;

    for (const left of allPermissionMaps) {
      for (const right of allPermissionMaps) {
        const policy = policyForContributions(left, right);
        const effective = unionGitHubInstallationPermissions(left, right);

        for (const requested of nonEmptyPermissionMaps) {
          expect(
            tokenIssuancePolicyPermits(policy, matchingSubjectToken, requestFor(requested)),
          ).toBe(materializedPermissionsCover(effective, requested));
          cases += 1;
        }
      }
    }

    expect(cases).toBe(3_840);
  });

  it("is permission-separable for every pair of non-empty requests", () => {
    let cases = 0;

    for (const configured of allPermissionMaps) {
      const policy = policyForContributions(configured);

      for (const left of nonEmptyPermissionMaps) {
        for (const right of nonEmptyPermissionMaps) {
          const union = unionGitHubInstallationPermissions(left, right);
          const permitsUnion = tokenIssuancePolicyPermits(
            policy,
            matchingSubjectToken,
            requestFor(union),
          );
          const permitsSeparately =
            tokenIssuancePolicyPermits(policy, matchingSubjectToken, requestFor(left)) &&
            tokenIssuancePolicyPermits(policy, matchingSubjectToken, requestFor(right));

          expect(permitsUnion).toBe(permitsSeparately);
          cases += 1;
        }
      }
    }

    expect(cases).toBe(3_600);
  });
});
