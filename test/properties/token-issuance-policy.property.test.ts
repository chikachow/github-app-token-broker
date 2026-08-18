import { test } from "@fast-check/vitest";
import fc from "fast-check";
import { expect } from "vitest";

import {
  createInstallationAccessTokenRequest,
  type GitHubInstallationPermissionLevel,
  type GitHubInstallationPermissions,
} from "@github-app-token-broker/github/installation-access-token-request";
import type { VerifiedSubjectToken } from "@github-app-token-broker/oidc/id-token-authenticator";
import {
  parseOidcIssuerIdentifier,
  type OidcIssuerIdentifier,
} from "@github-app-token-broker/oidc/provider-registration";
import {
  claimEquals,
  claimOneOf,
  compileTokenIssuancePolicy,
  evaluateTokenIssuancePolicy,
  githubRepositoryOwnerResourceConstraint,
  githubRepositoryResourceConstraint,
  oidcSubjectTokenConstraint,
  type ClaimPredicateDefinition,
  type PermitStatementDefinition,
} from "@github-app-token-broker/token-issuance-policy";

interface PolicyScenario {
  readonly claims: Readonly<Record<string, unknown>>;
  readonly issuer: OidcIssuerIdentifier;
  readonly permitStatements: readonly PermitStatementDefinition[];
  readonly request: {
    readonly owner: string;
    readonly permissions: GitHubInstallationPermissions;
    readonly repository: string;
  };
}

type PolicyScenarioCategory =
  | "mixed-policy"
  | "multi-statement-composition"
  | "requested-permissions-unsupported"
  | "single-statement-permit"
  | "subject-token-unacceptable"
  | "subject-token-unacceptable-cross-contribution"
  | "target-unsupported"
  | "unsupported-permissions-before-unacceptable-subject";

interface TaggedPolicyScenario extends PolicyScenario {
  readonly category: PolicyScenarioCategory;
}

type ExpectedPolicyOutcome =
  | "permitted"
  | "requested_permissions_unsupported"
  | "subject_token_unacceptable"
  | "target_unsupported";

const permissionLevelRanks: Readonly<Record<GitHubInstallationPermissionLevel, number>> = {
  admin: 3,
  read: 1,
  write: 2,
};
const generatedRunBudget = 1_000;

const matchingIssuer = requiredIssuer("https://matching-issuer.example");
const otherIssuer = requiredIssuer("https://other-issuer.example");
const targetResource = { owner: "target-owner", repository: "target-repository" } as const;
const sameOwnerOtherResource = {
  owner: "target-owner",
  repository: "other-target-repository",
} as const;
const otherResource = { owner: "other-owner", repository: "other-repository" } as const;
const targetOwnerResource = { owner: "target-owner", repository: null } as const;
const otherOwnerResource = { owner: "other-owner", repository: null } as const;

const permissionNameArbitrary = fc.oneof(
  {
    arbitrary: fc.constantFrom("__proto__", "constructor", "toString"),
    weight: 5,
  },
  {
    arbitrary: fc.constantFrom(
      "actions",
      "checks",
      "contents",
      "future_permission",
      "issues",
      "metadata",
      "pull_requests",
      "statuses",
      "workflows",
    ),
    weight: 5,
  },
);
const permissionLevelArbitrary = fc.constantFrom<GitHubInstallationPermissionLevel>(
  "read",
  "write",
  "admin",
);
const permissionEntriesArbitrary = fc.uniqueArray(
  fc.tuple(permissionNameArbitrary, permissionLevelArbitrary),
  {
    maxLength: 6,
    minLength: 1,
    selector: ([name]) => name,
  },
);
const multiPermissionEntriesArbitrary = fc.uniqueArray(
  fc.tuple(permissionNameArbitrary, permissionLevelArbitrary),
  {
    maxLength: 6,
    minLength: 2,
    selector: ([name]) => name,
  },
);
const permissionMapArbitrary = permissionEntriesArbitrary.map(permissionMap);

const claimNameArbitrary = fc.oneof(
  {
    arbitrary: fc.constantFrom("__proto__", "constructor", "toString"),
    weight: 4,
  },
  {
    arbitrary: fc.constantFrom("branch", "environment", "event_name", "repository", "trusted"),
    weight: 6,
  },
);
const claimValueArbitrary = fc.oneof(
  fc.constantFrom("main", "production", "push", "workflow_dispatch", "value"),
  fc.boolean(),
  fc.constant(null),
  fc.integer({ max: 2, min: 0 }),
);
const claimEntriesArbitrary = fc.uniqueArray(fc.tuple(claimNameArbitrary, claimValueArbitrary), {
  maxLength: 6,
  minLength: 1,
  selector: ([name]) => name,
});

const mixedPolicyScenarioArbitrary: fc.Arbitrary<PolicyScenario> = claimEntriesArbitrary.chain(
  (claimEntries) => {
    const predicateArbitrary = fc
      .uniqueArray(
        fc.record({
          claimName: fc.oneof(
            { arbitrary: fc.constantFrom(...claimEntries.map(([name]) => name)), weight: 4 },
            { arbitrary: fc.constant("absent_claim"), weight: 1 },
          ),
          kind: fc.constantFrom<"claim-equals" | "claim-one-of">("claim-equals", "claim-one-of"),
          shouldMatch: fc.boolean(),
        }),
        { maxLength: 3, selector: ({ claimName }) => claimName },
      )
      .map((seeds) =>
        seeds.map(({ claimName, kind, shouldMatch }) =>
          predicateFromSeed(claimEntries, claimName, kind, shouldMatch),
        ),
      );
    const statementArbitrary = fc
      .record({
        issuer: fc.constantFrom(matchingIssuer, otherIssuer),
        permissions: permissionMapArbitrary,
        predicates: predicateArbitrary,
        resource: fc.constantFrom(
          targetResource,
          targetOwnerResource,
          sameOwnerOtherResource,
          otherResource,
          otherOwnerResource,
        ),
      })
      .map(({ issuer, permissions, predicates, resource }) =>
        statement(permissions, { issuer, predicates, resource }),
      );

    return fc
      .record({
        decoration: fc.constantFrom<"as-is" | "duplicate-first" | "reverse" | "split-first">(
          "as-is",
          "duplicate-first",
          "reverse",
          "split-first",
        ),
        // Four random statements still exercise composition and ordering while keeping the
        // authorization property within the suite's wall-time budget. Fixed examples below
        // guarantee the security-critical multi-statement shapes on every run.
        permitStatements: fc.array(statementArbitrary, { maxLength: 4 }),
        requestPermissions: permissionMapArbitrary,
      })
      .map(({ decoration, permitStatements, requestPermissions }): PolicyScenario => ({
        claims: claimsRecord(claimEntries),
        issuer: matchingIssuer,
        permitStatements: decorateStatements(permitStatements, decoration),
        request: { ...targetResource, permissions: requestPermissions },
      }));
  },
);

const subjectFailureArbitrary = fc.constantFrom<"issuer" | "predicate">("issuer", "predicate");

const singleStatementPermitArbitrary: fc.Arbitrary<TaggedPolicyScenario> = fc
  .tuple(permissionMapArbitrary, fc.boolean())
  .map(([permissions, ownerWide]) =>
    taggedScenario(
      "single-statement-permit",
      scenario(
        [statement(permissions, { resource: ownerWide ? targetOwnerResource : targetResource })],
        permissions,
      ),
    ),
  );

const multiStatementCompositionArbitrary: fc.Arbitrary<TaggedPolicyScenario> =
  multiPermissionEntriesArbitrary.chain((entries) =>
    fc
      .integer({ max: entries.length - 1, min: 1 })
      .map((splitAt) =>
        taggedScenario(
          "multi-statement-composition",
          scenario(
            [
              statement(permissionMap(entries.slice(0, splitAt))),
              statement(permissionMap(entries.slice(splitAt)), { resource: targetOwnerResource }),
            ],
            permissionMap(entries),
          ),
        ),
      ),
  );

const twoPermissionEntriesArbitrary = fc.uniqueArray(
  fc.tuple(permissionNameArbitrary, permissionLevelArbitrary),
  {
    maxLength: 2,
    minLength: 2,
    selector: ([name]) => name,
  },
);

const crossContributionArbitrary: fc.Arbitrary<TaggedPolicyScenario> = fc
  .tuple(twoPermissionEntriesArbitrary, subjectFailureArbitrary)
  .map(([entries, failure]) =>
    taggedScenario(
      "subject-token-unacceptable-cross-contribution",
      scenario(
        [
          statement(
            permissionMap([requiredPermissionEntry(entries, 1)]),
            failedSubjectOptions(failure),
          ),
          statement(permissionMap([requiredPermissionEntry(entries, 0)])),
        ],
        permissionMap(entries),
      ),
    ),
  );

const targetUnsupportedArbitrary: fc.Arbitrary<TaggedPolicyScenario> = fc
  .tuple(
    permissionMapArbitrary,
    fc.constantFrom(sameOwnerOtherResource, otherResource, otherOwnerResource),
  )
  .map(([permissions, resource]) =>
    taggedScenario(
      "target-unsupported",
      scenario([statement(permissions, { resource })], permissions),
    ),
  );

const requestedPermissionsUnsupportedArbitrary: fc.Arbitrary<TaggedPolicyScenario> =
  twoPermissionEntriesArbitrary.map((entries) =>
    taggedScenario(
      "requested-permissions-unsupported",
      scenario(
        [statement(permissionMap([requiredPermissionEntry(entries, 0)]))],
        permissionMap(entries),
      ),
    ),
  );

const subjectTokenUnacceptableArbitrary: fc.Arbitrary<TaggedPolicyScenario> = fc
  .tuple(permissionMapArbitrary, subjectFailureArbitrary)
  .map(([permissions, failure]) =>
    taggedScenario(
      "subject-token-unacceptable",
      scenario([statement(permissions, failedSubjectOptions(failure))], permissions),
    ),
  );

const simultaneousFailurePrecedenceArbitrary: fc.Arbitrary<TaggedPolicyScenario> = fc
  .tuple(twoPermissionEntriesArbitrary, subjectFailureArbitrary)
  .map(([entries, failure]) =>
    taggedScenario(
      "unsupported-permissions-before-unacceptable-subject",
      scenario(
        [
          statement(
            permissionMap([requiredPermissionEntry(entries, 0)]),
            failedSubjectOptions(failure),
          ),
        ],
        permissionMap(entries),
      ),
    ),
  );

const tokenIssuancePolicyScenarioArbitrary: fc.Arbitrary<TaggedPolicyScenario> = fc.oneof(
  { arbitrary: singleStatementPermitArbitrary, weight: 1 },
  { arbitrary: multiStatementCompositionArbitrary, weight: 1 },
  { arbitrary: crossContributionArbitrary, weight: 1 },
  { arbitrary: targetUnsupportedArbitrary, weight: 1 },
  { arbitrary: requestedPermissionsUnsupportedArbitrary, weight: 1 },
  { arbitrary: subjectTokenUnacceptableArbitrary, weight: 1 },
  { arbitrary: simultaneousFailurePrecedenceArbitrary, weight: 1 },
  {
    arbitrary: mixedPolicyScenarioArbitrary.map((policyScenario) =>
      taggedScenario("mixed-policy", policyScenario),
    ),
    weight: 3,
  },
);

const semanticExamples: readonly TaggedPolicyScenario[] = [
  taggedScenario(
    "single-statement-permit",
    scenario([statement({ contents: "read" })], { contents: "read" }),
  ),
  taggedScenario(
    "multi-statement-composition",
    scenario([statement({ actions: "read" }), statement({ contents: "read" })], {
      actions: "read",
      contents: "read",
    }),
  ),
  taggedScenario(
    "subject-token-unacceptable-cross-contribution",
    scenario(
      [statement({ contents: "read" }, { issuer: otherIssuer }), statement({ actions: "read" })],
      { actions: "read", contents: "read" },
    ),
  ),
  taggedScenario(
    "target-unsupported",
    scenario([statement({ contents: "read" }, { resource: otherResource })], { contents: "read" }),
  ),
  taggedScenario(
    "requested-permissions-unsupported",
    scenario([statement({ contents: "read" })], { actions: "read", contents: "read" }),
  ),
  taggedScenario(
    "subject-token-unacceptable",
    scenario([statement({ contents: "read" }, { issuer: otherIssuer })], { contents: "read" }),
  ),
  taggedScenario(
    "subject-token-unacceptable",
    scenario(
      [statement({ contents: "read" }, { predicates: [claimEquals("environment", "production")] })],
      { contents: "read" },
      claimsRecord([["environment", "development"]]),
    ),
  ),
  taggedScenario(
    "unsupported-permissions-before-unacceptable-subject",
    scenario([statement({ contents: "read" }, { issuer: otherIssuer })], {
      actions: "read",
      contents: "read",
    }),
  ),
  taggedScenario("mixed-policy", scenario([], { contents: "read" })),
  taggedScenario(
    "mixed-policy",
    scenario(
      [
        statement({ contents: "write" }),
        statement({ actions: "read" }),
        statement({ contents: "write" }),
      ],
      { actions: "read", contents: "read" },
    ),
  ),
  taggedScenario(
    "mixed-policy",
    scenario([statement({ contents: "read" })], { contents: "write" }),
  ),
  taggedScenario(
    "mixed-policy",
    scenario([statement({ contents: "admin" })], { contents: "write" }),
  ),
  taggedScenario(
    "mixed-policy",
    scenario(
      [statement({ contents: "write" }, { resource: targetOwnerResource })],
      { contents: "read" },
      claimsRecord([]),
      sameOwnerOtherResource,
    ),
  ),
  taggedScenario(
    "mixed-policy",
    scenario(
      [
        statement(permissionMap([["__proto__", "admin"]]), {
          predicates: [claimEquals("__proto__", "literal")],
        }),
      ],
      permissionMap([["__proto__", "write"]]),
      claimsRecord([["__proto__", "literal"]]),
    ),
  ),
  taggedScenario(
    "mixed-policy",
    scenario(
      [statement({ contents: "read" }, { predicates: [claimEquals("inherited", "value")] })],
      { contents: "read" },
      claimsRecord([], { inherited: "value" }),
    ),
  ),
];

const expectedOutcomeByCategory = {
  "mixed-policy": undefined,
  "multi-statement-composition": "permitted",
  "requested-permissions-unsupported": "requested_permissions_unsupported",
  "single-statement-permit": "permitted",
  "subject-token-unacceptable": "subject_token_unacceptable",
  "subject-token-unacceptable-cross-contribution": "subject_token_unacceptable",
  "target-unsupported": "target_unsupported",
  "unsupported-permissions-before-unacceptable-subject": "requested_permissions_unsupported",
} satisfies Readonly<Record<PolicyScenarioCategory, ExpectedPolicyOutcome | undefined>>;

test.prop([tokenIssuancePolicyScenarioArbitrary], {
  examples: semanticExamples.map((example) => [example]),
  numRuns: generatedRunBudget + semanticExamples.length,
})("matches an independent compiled policy-evaluation oracle", (policyScenario) => {
  const expected = evaluatePolicyScenario(policyScenario);
  const actual = evaluatePublicPolicy(policyScenario);
  const categoryExpected = expectedOutcomeByCategory[policyScenario.category];

  if (categoryExpected !== undefined) {
    expect(expected, policyScenario.category).toBe(categoryExpected);
  }

  expect(actual).toEqual(expected);
});

function evaluatePublicPolicy(policyScenario: PolicyScenario): ExpectedPolicyOutcome {
  const policy = compileTokenIssuancePolicy(policyScenario.permitStatements);
  const request = createInstallationAccessTokenRequest({
    owner: policyScenario.request.owner,
    permissions: policyScenario.request.permissions,
    repository: policyScenario.request.repository,
  });
  const verifiedSubjectToken = {
    claims: policyScenario.claims,
    issuer: policyScenario.issuer,
  } as VerifiedSubjectToken;

  return evaluateTokenIssuancePolicy(policy, verifiedSubjectToken, request).outcome;
}

function evaluatePolicyScenario(policyScenario: PolicyScenario): ExpectedPolicyOutcome {
  const targetStatements = policyScenario.permitStatements.filter(
    ({ resource }) =>
      resource.owner === policyScenario.request.owner &&
      (resource.repository === null || resource.repository === policyScenario.request.repository),
  );
  const applicableStatements = targetStatements.filter(
    ({ subjectToken }) =>
      subjectToken.issuer === policyScenario.issuer &&
      subjectToken.claimPredicates.every((predicate) =>
        claimPredicateMatches(predicate, policyScenario.claims),
      ),
  );

  if (pointwisePermissionsCover(applicableStatements, policyScenario.request.permissions)) {
    return "permitted";
  }

  if (targetStatements.length === 0) {
    return "target_unsupported";
  }

  return pointwisePermissionsCover(targetStatements, policyScenario.request.permissions)
    ? "subject_token_unacceptable"
    : "requested_permissions_unsupported";
}

function claimPredicateMatches(
  predicate: ClaimPredicateDefinition,
  claims: Readonly<Record<string, unknown>>,
): boolean {
  if (!Object.hasOwn(claims, predicate.claimName)) {
    return false;
  }

  const actual = claims[predicate.claimName];

  return predicate.kind === "claim-equals"
    ? actual === predicate.expectedValue
    : typeof actual === "string" && predicate.expectedValues.includes(actual);
}

function pointwisePermissionsCover(
  statements: readonly PermitStatementDefinition[],
  requested: GitHubInstallationPermissions,
): boolean {
  const effective: Record<string, GitHubInstallationPermissionLevel> = Object.create(null);

  for (const { permissions } of statements) {
    for (const name of Object.getOwnPropertyNames(permissions)) {
      const level = permissions[name];
      const current = Object.hasOwn(effective, name) ? effective[name] : undefined;

      if (
        level !== undefined &&
        (current === undefined || permissionLevelRanks[level] > permissionLevelRanks[current])
      ) {
        effective[name] = level;
      }
    }
  }

  return Object.getOwnPropertyNames(requested).every((name) => {
    const requestedLevel = requested[name];
    const effectiveLevel = Object.hasOwn(effective, name) ? effective[name] : undefined;

    return (
      requestedLevel !== undefined &&
      effectiveLevel !== undefined &&
      permissionLevelRanks[effectiveLevel] >= permissionLevelRanks[requestedLevel]
    );
  });
}

function predicateFromSeed(
  claimEntries: readonly (readonly [string, unknown])[],
  claimName: string,
  kind: "claim-equals" | "claim-one-of",
  shouldMatch: boolean,
): ClaimPredicateDefinition {
  const actual = claimEntries.find(([name]) => name === claimName)?.[1];

  if (kind === "claim-one-of") {
    if (shouldMatch && typeof actual === "string") {
      return claimOneOf(claimName, ["alternate", actual]);
    }

    return claimOneOf(claimName, ["not-the-claim-value"]);
  }

  if (shouldMatch && (typeof actual === "string" || typeof actual === "boolean")) {
    return claimEquals(claimName, actual);
  }

  return claimEquals(claimName, typeof actual === "boolean" ? !actual : "not-the-claim-value");
}

function decorateStatements(
  permitStatements: readonly PermitStatementDefinition[],
  decoration: "as-is" | "duplicate-first" | "reverse" | "split-first",
): readonly PermitStatementDefinition[] {
  if (decoration === "reverse") {
    return permitStatements.toReversed();
  }

  const first = permitStatements[0];

  if (first === undefined || decoration === "as-is") {
    return permitStatements;
  }

  if (decoration === "duplicate-first") {
    return [first, ...permitStatements];
  }

  const permissionEntries = Object.entries(first.permissions);

  if (permissionEntries.length < 2) {
    return permitStatements;
  }

  const splitAt = Math.ceil(permissionEntries.length / 2);
  const splitStatements = [
    { ...first, permissions: permissionMap(permissionEntries.slice(0, splitAt)) },
    { ...first, permissions: permissionMap(permissionEntries.slice(splitAt)) },
  ];

  return [...splitStatements, ...permitStatements.slice(1)];
}

function failedSubjectOptions(failure: "issuer" | "predicate"): Parameters<typeof statement>[1] {
  return failure === "issuer"
    ? { issuer: otherIssuer }
    : { predicates: [claimEquals("environment", "production")] };
}

function taggedScenario(
  category: PolicyScenarioCategory,
  policyScenario: PolicyScenario,
): TaggedPolicyScenario {
  return { category, ...policyScenario };
}

function scenario(
  permitStatements: readonly PermitStatementDefinition[],
  permissions: GitHubInstallationPermissions,
  claims = claimsRecord([]),
  resource: { readonly owner: string; readonly repository: string } = targetResource,
): PolicyScenario {
  return {
    claims,
    issuer: matchingIssuer,
    permitStatements,
    request: { ...resource, permissions },
  };
}

function statement(
  permissions: GitHubInstallationPermissions,
  options: {
    readonly issuer?: OidcIssuerIdentifier;
    readonly predicates?: readonly ClaimPredicateDefinition[];
    readonly resource?: { readonly owner: string; readonly repository: string | null };
  } = {},
): PermitStatementDefinition {
  const resource = options.resource ?? targetResource;

  return {
    permissions,
    resource:
      resource.repository === null
        ? githubRepositoryOwnerResourceConstraint(resource.owner)
        : githubRepositoryResourceConstraint(resource.owner, resource.repository),
    subjectToken: oidcSubjectTokenConstraint(
      options.issuer ?? matchingIssuer,
      ...(options.predicates ?? []),
    ),
  };
}

function permissionMap(
  entries: readonly (readonly [string, GitHubInstallationPermissionLevel])[],
): GitHubInstallationPermissions {
  return Object.fromEntries(entries);
}

function requiredPermissionEntry(
  entries: readonly (readonly [string, GitHubInstallationPermissionLevel])[],
  index: number,
): readonly [string, GitHubInstallationPermissionLevel] {
  const entry = entries[index];

  if (entry === undefined) {
    throw new Error(`generated permission entry ${index} is missing`);
  }

  return entry;
}

function claimsRecord(
  entries: readonly (readonly [string, unknown])[],
  prototype: Readonly<Record<string, unknown>> | null = null,
): Readonly<Record<string, unknown>> {
  const claims = Object.create(prototype) as Record<string, unknown>;

  Object.assign(claims, {
    aud: "https://broker.example",
    exp: 4_000_000_000,
    iat: 1_000_000_000,
    iss: matchingIssuer,
    sub: "generated-subject",
  });

  for (const [name, value] of entries) {
    claims[name] = value;
  }

  return claims;
}

function requiredIssuer(value: string): OidcIssuerIdentifier {
  const issuer = parseOidcIssuerIdentifier(value);

  if (issuer === null) {
    throw new Error(`invalid test OIDC Issuer Identifier: ${value}`);
  }

  return issuer;
}
