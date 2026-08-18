const githubSource = "packages/github/src/installation-access-token-request.ts";
const githubPropertyTest = "test/properties/installation-access-token-request.property.test.ts";
const policySource = "packages/token-issuance-policy/src/token-issuance-policy.ts";
const policyPropertyTest = "test/properties/token-issuance-policy.property.test.ts";
const fullTestSuite = lane([], []);
const ordinaryTestSuite = lane([], ["unit", "worker-integration"]);

const githubTests = Object.freeze({
  full: fullTestSuite,
  ordinary: ordinaryTestSuite,
  property: lane([githubPropertyTest], ["property"]),
  suite: "github",
});
const policyTests = Object.freeze({
  full: fullTestSuite,
  ordinary: ordinaryTestSuite,
  property: lane([policyPropertyTest], ["property"]),
  suite: "policy",
});

export const propertyMutations = Object.freeze([
  mutation({
    description: "omit canonical permission sorting",
    file: githubSource,
    id: "github-permission-sorting",
    replacement: `void comparePermissionEntry;
  return Object.freeze(Object.fromEntries(entries));`,
    search: "return Object.freeze(Object.fromEntries(entries.sort(comparePermissionEntry)));",
    tests: githubTests,
  }),
  mutation({
    description: "return the mutable permission source instead of a frozen copy",
    file: githubSource,
    id: "github-permission-copy",
    replacement: `void comparePermissionEntry;
  return permissions;`,
    search: "return Object.freeze(Object.fromEntries(entries.sort(comparePermissionEntry)));",
    tests: githubTests,
  }),
  mutation({
    description: "reverse read and write permission ranks",
    file: githubSource,
    id: "github-permission-rank",
    replacement: `read: 2,
  write: 1,`,
    search: `read: 1,
  write: 2,`,
    tests: policyTests,
  }),
  mutation({
    description: "let every repository resource constraint match",
    file: policySource,
    id: "policy-resource-always-matches",
    replacement: `function resourceConstraintMatches(
  constraint: GitHubRepositoryResourceConstraint,
  resource: GitHubRepositoryResource,
): boolean {
  void constraint;
  void resource;
  return true;
}`,
    search: `function resourceConstraintMatches(
  constraint: GitHubRepositoryResourceConstraint,
  resource: GitHubRepositoryResource,
): boolean {
  return (
    constraint.owner === resource.owner &&
    (constraint.repository === null || constraint.repository === resource.repository)
  );
}`,
    tests: policyTests,
  }),
  mutation({
    description: "treat an owner-wide constraint as an exact repository constraint",
    file: policySource,
    id: "policy-owner-wide-is-exact",
    replacement: "constraint.repository === resource.repository",
    search: "(constraint.repository === null || constraint.repository === resource.repository)",
    tests: policyTests,
  }),
  mutation({
    description: "let a wrong-issuer statement contribute permissions",
    file: policySource,
    id: "policy-ignore-issuer",
    replacement: "true &&",
    search: "statement.subjectToken.issuer === verifiedSubjectToken.issuer &&",
    tests: policyTests,
  }),
  mutation({
    description: "ignore failed Claim predicates",
    file: policySource,
    id: "policy-ignore-claim-predicates",
    replacement: "(void claimPredicatesMatch, true)",
    search:
      "claimPredicatesMatch(statement.subjectToken.claimPredicates, verifiedSubjectToken.claims)",
    tests: policyTests,
  }),
  mutation({
    description: "accept inherited Claims as subject-token evidence",
    file: policySource,
    id: "policy-accept-inherited-claims",
    replacement: "if (!(predicate.claimName in claims)) {",
    search: "if (!Object.hasOwn(claims, predicate.claimName)) {",
    tests: policyTests,
  }),
  mutation({
    description: "stop after the first matching-subject contribution",
    file: policySource,
    id: "policy-first-contribution-only",
    replacement: `if (permissionsNotCoveredForMatchingSubject.size === 0) {
        return permittedEvaluation;
      }

      break;`,
    search: `if (permissionsNotCoveredForMatchingSubject.size === 0) {
        return permittedEvaluation;
      }`,
    tests: policyTests,
  }),
  mutation({
    description: "permit after any one requested permission is covered",
    file: policySource,
    id: "policy-any-permission-suffices",
    replacement:
      "if (permissionsNotCoveredForMatchingSubject.size < Object.keys(request.permissions).length) {",
    search: "if (permissionsNotCoveredForMatchingSubject.size === 0) {",
    tests: policyTests,
  }),
  mutation({
    description: "swap unsupported-permission and unacceptable-subject classifications",
    file: policySource,
    id: "policy-swap-denial-classification",
    replacements: Object.freeze([
      Object.freeze({
        replacement: `const requestedPermissionsUnsupportedEvaluation = Object.freeze({
  outcome: "subject_token_unacceptable",
} as const);`,
        search: `const requestedPermissionsUnsupportedEvaluation = Object.freeze({
  outcome: "requested_permissions_unsupported",
} as const);`,
      }),
      Object.freeze({
        replacement: `const subjectTokenUnacceptableEvaluation = Object.freeze({
  outcome: "requested_permissions_unsupported",
} as const);`,
        search: `const subjectTokenUnacceptableEvaluation = Object.freeze({
  outcome: "subject_token_unacceptable",
} as const);`,
      }),
    ]),
    tests: policyTests,
  }),
  mutation({
    description: "accept conflicting duplicate scope levels",
    file: githubSource,
    id: "github-scope-conflicting-duplicate",
    replacement: "if (permissions[name] !== undefined && permissions[name] === level) {",
    search: "if (permissions[name] !== undefined) {",
    tests: githubTests,
  }),
  mutation({
    description: "split GitHub scopes on general whitespace",
    file: githubSource,
    id: "github-scope-general-whitespace",
    replacement: `const scopeTokens = value.split(/\\s+/u);`,
    search: `const scopeTokens = value.split(" ");`,
    tests: githubTests,
  }),
  mutation({
    description: "accept a repository resource containing a query",
    file: githubSource,
    id: "github-resource-query",
    replacement: "",
    search: "resource.search.length !== 0 ||",
    tests: githubTests,
  }),
  mutation({
    description: "accept an encoded separator in a repository resource segment",
    file: githubSource,
    id: "github-resource-encoded-separator",
    replacement: "/^[A-Za-z0-9_.%-]+$/u.test(value)",
    search: "/^[A-Za-z0-9_.-]+$/u.test(value)",
    tests: githubTests,
  }),
  mutation({
    description: "let target-matching failed-subject statements contribute to permission",
    file: policySource,
    id: "policy-cross-subject-contribution",
    replacement: "if (permissionsNotCoveredForResource.size === 0) {",
    search: "if (permissionsNotCoveredForMatchingSubject.size === 0) {",
    tests: policyTests,
  }),
]);

function mutation(definition) {
  const replacements =
    definition.replacements ??
    Object.freeze([
      Object.freeze({ replacement: definition.replacement, search: definition.search }),
    ]);
  return Object.freeze({
    description: definition.description,
    file: definition.file,
    id: definition.id,
    replacements,
    tests: definition.tests,
  });
}

function lane(files, projects) {
  return Object.freeze({
    files: Object.freeze(files),
    projects: Object.freeze(projects),
  });
}
