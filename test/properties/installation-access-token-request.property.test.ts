import { test } from "@fast-check/vitest";
import fc from "fast-check";
import { describe, expect } from "vitest";

import {
  canonicalizeInstallationAccessTokenPermissions,
  createGitHubRepositoryResource,
  type GitHubInstallationPermissionLevel,
  type GitHubInstallationPermissions,
  normalizeInstallationAccessTokenRequest,
  parseGitHubRepositoryResource,
} from "@github-app-token-broker/github/installation-access-token-request";

const generatedRunBudget = 1_000;
const repositoryResource = "https://api.github.com/repos/property-owner/property-repository";
const prototypeNamedPermissions = ["__proto__", "constructor", "toString"] as const;
const permissionLevels = ["read", "write", "admin"] as const;

const permissionLevelArbitrary = fc.constantFrom(...permissionLevels);
const asciiCodePointArbitrary = (min: number, max: number) =>
  fc.integer({ max, min }).map((codePoint) => String.fromCodePoint(codePoint));
const permissionNameCharacterArbitrary = fc.oneof(
  fc.constant("!"),
  asciiCodePointArbitrary(0x23, 0x39),
  asciiCodePointArbitrary(0x3b, 0x5b),
  asciiCodePointArbitrary(0x5d, 0x7e),
);
const ordinaryPermissionNameArbitrary = fc.string({
  maxLength: 16,
  minLength: 1,
  unit: permissionNameCharacterArbitrary,
});
const permissionNameArbitrary = fc.oneof(
  { arbitrary: fc.constantFrom(...prototypeNamedPermissions), weight: 4 },
  { arbitrary: ordinaryPermissionNameArbitrary, weight: 6 },
);

function permissionEntriesArbitrary(options: { maxLength: number; minLength?: number }) {
  return fc.uniqueArray(fc.tuple(permissionNameArbitrary, permissionLevelArbitrary), {
    maxLength: options.maxLength,
    minLength: options.minLength ?? 0,
    selector: ([name]) => name,
  });
}

const distinctPermissionLevelsArbitrary = permissionLevelArbitrary.chain((left) =>
  fc
    .constantFrom(...permissionLevels.filter((candidate) => candidate !== left))
    .map((right) => [left, right] as const),
);
type PermissionEntry = readonly [string, GitHubInstallationPermissionLevel];
type CanonicalizationScenario = {
  entries: readonly PermissionEntry[];
  permutation: readonly PermissionEntry[];
};

const canonicalizationScenarioArbitrary: fc.Arbitrary<CanonicalizationScenario> =
  permissionEntriesArbitrary({ maxLength: 6 }).chain((entries) =>
    fc
      .shuffledSubarray(entries, { maxLength: entries.length, minLength: entries.length })
      .map((permutation) => ({ entries, permutation })),
  );
const canonicalizationExamples: [CanonicalizationScenario][] = [
  [{ entries: [], permutation: [] }],
  ...prototypeNamedPermissions.map(
    (name) =>
      [
        {
          entries: [
            [name, "admin"],
            ["actions", "read"],
          ],
          permutation: [
            ["actions", "read"],
            [name, "admin"],
          ],
        },
      ] satisfies [CanonicalizationScenario],
  ),
  [
    {
      entries: [
        ["1", "read"],
        ["z-last", "admin"],
        ["a-first", "write"],
      ],
      permutation: [
        ["a-first", "write"],
        ["1", "read"],
        ["z-last", "admin"],
      ],
    },
  ],
];

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function expectFrozenOwnPermissionData(
  actual: GitHubInstallationPermissions,
  expected: GitHubInstallationPermissions,
): void {
  const expectedNames = Object.getOwnPropertyNames(expected).sort(compareStrings);
  const expectedDescriptors = Object.fromEntries(
    expectedNames.map((name) => [
      name,
      {
        configurable: false,
        enumerable: true,
        value: expected[name],
        writable: false,
      },
    ]),
  );

  expect({
    descriptors: Object.getOwnPropertyDescriptors(actual),
    frozen: Object.isFrozen(actual),
    names: new Set(Object.getOwnPropertyNames(actual)),
    permissions: actual,
    symbols: Object.getOwnPropertySymbols(actual),
  }).toEqual({
    descriptors: expectedDescriptors,
    frozen: true,
    names: new Set(expectedNames),
    permissions: expected,
    symbols: [],
  });
}

const validScopeArbitrary = permissionEntriesArbitrary({ maxLength: 6, minLength: 1 }).chain(
  (entries) => {
    const tokens = entries.map(([name, level]) => `${name}:${level}`);

    return fc
      .subarray(tokens, { maxLength: Math.min(tokens.length, 8 - tokens.length) })
      .chain((duplicateTokens) => {
        const tokensWithIdenticalDuplicates = [...tokens, ...duplicateTokens];

        return fc
          .shuffledSubarray(tokensWithIdenticalDuplicates, {
            maxLength: tokensWithIdenticalDuplicates.length,
            minLength: tokensWithIdenticalDuplicates.length,
          })
          .map((shuffledTokens) => ({ entries, scope: shuffledTokens.join(" ") }));
      });
  },
);

type ScopeScenario =
  | {
      entries: readonly (readonly [string, GitHubInstallationPermissionLevel])[];
      kind: "valid";
      scope: string;
    }
  | { kind: "conflict" | "newline" | "tab"; scope: string };

const scopeScenarioArbitrary: fc.Arbitrary<ScopeScenario> = fc.oneof(
  validScopeArbitrary.map(({ entries, scope }) => ({ entries, kind: "valid" as const, scope })),
  fc
    .tuple(permissionNameArbitrary, distinctPermissionLevelsArbitrary)
    .map(([name, [left, right]]) => ({
      kind: "conflict" as const,
      scope: `${name}:${left} ${name}:${right} ${name}:${left}`,
    })),
  permissionEntriesArbitrary({ maxLength: 2, minLength: 2 }).chain((entries) =>
    fc.constantFrom("tab" as const, "newline" as const).map((kind) => ({
      kind,
      scope: entries.map(([name, level]) => `${name}:${level}`).join(kind === "tab" ? "\t" : "\n"),
    })),
  ),
);
const scopeScenarioExamples: [ScopeScenario][] = [
  [
    {
      entries: [
        ["contents", "read"],
        ["actions", "write"],
      ],
      kind: "valid",
      scope: "contents:read actions:write contents:read actions:write",
    },
  ],
  [{ kind: "conflict", scope: "contents:read contents:write contents:read" }],
  [{ kind: "tab", scope: "contents:read\tactions:write" }],
  [{ kind: "newline", scope: "contents:read\nactions:write" }],
];

const resourceScenarios = [
  "valid",
  "scheme",
  "host casing",
  "credentials",
  "port",
  "query",
  "fragment",
  "trailing slash",
  "path addition",
  "dot segment",
  "encoded separator",
  "leading whitespace",
  "trailing whitespace",
] as const;

type ResourceScenario = (typeof resourceScenarios)[number];

interface RepositoryResourceScenario {
  readonly owner: string;
  readonly repository: string;
  readonly scenario: ResourceScenario;
}

const repositorySegmentCharacterArbitrary = fc.oneof(
  asciiCodePointArbitrary(0x30, 0x39),
  asciiCodePointArbitrary(0x41, 0x5a),
  asciiCodePointArbitrary(0x61, 0x7a),
  fc.constantFrom("_", "-", "."),
);
const repositorySegmentFirstCharacterArbitrary = fc.oneof(
  asciiCodePointArbitrary(0x30, 0x39),
  asciiCodePointArbitrary(0x41, 0x5a),
  asciiCodePointArbitrary(0x61, 0x7a),
  fc.constantFrom("_", "-"),
);

const repositorySegmentArbitrary = fc.oneof(
  fc.constantFrom("a", "_", "-", ".a", "a.", "...", "Owner.Name", "repository.git"),
  fc
    .tuple(
      repositorySegmentFirstCharacterArbitrary,
      fc.string({
        maxLength: 31,
        unit: repositorySegmentCharacterArbitrary,
      }),
    )
    .map(([first, rest]) => `${first}${rest}`),
);

const repositoryResourceScenarioArbitrary: fc.Arbitrary<RepositoryResourceScenario> = fc.record({
  owner: repositorySegmentArbitrary,
  repository: repositorySegmentArbitrary,
  scenario: fc.constantFrom(...resourceScenarios),
});

const repositoryResourceScenarioExamples: [RepositoryResourceScenario][] = resourceScenarios.map(
  (scenario) => [{ owner: "Owner.Name", repository: "repository.git", scenario }],
);

function expectRepositoryResourceScenario({
  owner,
  repository,
  scenario,
}: RepositoryResourceScenario): void {
  const canonical = `https://api.github.com/repos/${owner}/${repository}`;

  if (scenario === "valid") {
    const resource = createGitHubRepositoryResource({ owner, repository });

    expect({
      frozen: Object.isFrozen(resource),
      parsed: parseGitHubRepositoryResource(canonical),
      resource,
    }).toEqual({
      frozen: true,
      parsed: resource,
      resource: { href: canonical, owner, repository },
    });
    return;
  }

  expect(
    parseGitHubRepositoryResource(resourceForScenario(canonical, owner, repository, scenario)),
    scenario,
  ).toBeNull();
}

function resourceForScenario(
  canonical: string,
  owner: string,
  repository: string,
  scenario: Exclude<ResourceScenario, "valid">,
): string {
  const prefix = "https://api.github.com/repos/";

  switch (scenario) {
    case "scheme":
      return canonical.replace("https://", "http://");
    case "host casing":
      return canonical.replace("api.github.com", "API.GITHUB.COM");
    case "credentials":
      return canonical.replace("https://", "https://user@");
    case "port":
      return canonical.replace("api.github.com", "api.github.com:8443");
    case "query":
      return `${canonical}?page=1`;
    case "fragment":
      return `${canonical}#readme`;
    case "trailing slash":
      return `${canonical}/`;
    case "path addition":
      return `${canonical}/actions`;
    case "dot segment":
      return `${prefix}${owner}/extra/../${repository}`;
    case "encoded separator":
      return `${prefix}${owner}%2Fother/${repository}`;
    case "leading whitespace":
      return ` ${canonical}`;
    case "trailing whitespace":
      return `${canonical} `;
  }
}

describe("GitHub installation permission properties", () => {
  test.prop([canonicalizationScenarioArbitrary], {
    examples: canonicalizationExamples,
    numRuns: generatedRunBudget + canonicalizationExamples.length,
  })(
    "canonicalizes permissions independently of insertion order without retaining mutable input",
    ({ entries, permutation }) => {
      const source = Object.fromEntries(entries) as GitHubInstallationPermissions;
      const permutedSource = Object.fromEntries(permutation) as GitHubInstallationPermissions;
      const sourceBefore = Object.getOwnPropertyDescriptors(source);
      const permutedSourceBefore = Object.getOwnPropertyDescriptors(permutedSource);
      const expected = Object.fromEntries(
        [...entries].sort(([left], [right]) => compareStrings(left, right)),
      ) as GitHubInstallationPermissions;
      const canonical = canonicalizeInstallationAccessTokenPermissions(source);
      const canonicalPermutation = canonicalizeInstallationAccessTokenPermissions(permutedSource);
      const canonicalAgain = canonicalizeInstallationAccessTokenPermissions(canonical);
      const expectedNames = Object.getOwnPropertyNames(expected);

      expectFrozenOwnPermissionData(canonical, expected);
      expect({
        canonicalAgain,
        canonicalAgainFrozen: Object.isFrozen(canonicalAgain),
        canonicalAgainNames: Object.getOwnPropertyNames(canonicalAgain),
        canonicalIsSource: canonical === source,
        canonicalPermutation,
        canonicalPermutationFrozen: Object.isFrozen(canonicalPermutation),
        canonicalPermutationIsSource: canonicalPermutation === permutedSource,
        canonicalPermutationNames: Object.getOwnPropertyNames(canonicalPermutation),
        canonicalNames: Object.getOwnPropertyNames(canonical),
        permutedSource: Object.getOwnPropertyDescriptors(permutedSource),
        source: Object.getOwnPropertyDescriptors(source),
      }).toEqual({
        canonicalAgain: expected,
        canonicalAgainFrozen: true,
        canonicalAgainNames: expectedNames,
        canonicalIsSource: false,
        canonicalPermutation: expected,
        canonicalPermutationFrozen: true,
        canonicalPermutationIsSource: false,
        canonicalPermutationNames: expectedNames,
        canonicalNames: expectedNames,
        permutedSource: permutedSourceBefore,
        source: sourceBefore,
      });
    },
  );
});

describe("GitHub installation scope properties", () => {
  test.prop([scopeScenarioArbitrary], {
    examples: scopeScenarioExamples,
    numRuns: generatedRunBudget + scopeScenarioExamples.length,
  })(
    "normalizes valid scopes and rejects conflicting or whitespace-separated scopes",
    (scenario) => {
      const result = normalizeInstallationAccessTokenRequest({
        resource: repositoryResource,
        scope: scenario.scope,
      });

      if (scenario.kind === "valid") {
        const expectedEntries = [...scenario.entries].sort(([left], [right]) =>
          compareStrings(left, right),
        );
        const expectedPermissions = Object.fromEntries(expectedEntries);
        const expectedScope = Object.entries(expectedPermissions)
          .map(([name, level]) => `${name}:${level}`)
          .join(" ");

        expect(result.ok).toBe(true);
        if (!result.ok) {
          return;
        }

        expect({
          frozenPermissions: Object.isFrozen(result.tokenRequest.permissions),
          normalizedAgain: normalizeInstallationAccessTokenRequest({
            resource: result.tokenRequest.resource.href,
            scope: result.tokenRequest.scope,
          }),
          permissions: result.tokenRequest.permissions,
          scope: result.tokenRequest.scope,
        }).toEqual({
          frozenPermissions: true,
          normalizedAgain: result,
          permissions: expectedPermissions,
          scope: expectedScope,
        });
      } else {
        expect(result).toEqual({ error: "invalid_scope", ok: false });
      }
    },
  );
});

describe("GitHub Repository Resource properties", () => {
  test.prop([repositoryResourceScenarioArbitrary], {
    examples: repositoryResourceScenarioExamples,
    numRuns: generatedRunBudget + repositoryResourceScenarioExamples.length,
  })("round-trips canonical resources and rejects each reviewed mutation", (scenario) => {
    expectRepositoryResourceScenario(scenario);
  });
});
