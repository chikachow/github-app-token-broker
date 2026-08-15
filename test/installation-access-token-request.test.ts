import { describe, expect, it } from "vitest";

import {
  canonicalizeInstallationAccessTokenPermissions,
  createInstallationAccessTokenRequest,
  createGitHubRepositoryResource,
  installationAccessTokenPermissionLevelCovers,
  installationAccessTokenPermissionsAreValid,
  isGitHubRepositoryResourcePathSegment,
  normalizeInstallationAccessTokenRequest,
  parseGitHubRepositoryResource,
} from "@github-app-token-broker/github/installation-access-token-request";
import {
  fixtureSourceResource,
  fixtureTargetResource,
  mustNormalizeTokenRequest,
} from "./support/installation-access-token-request.ts";

const malformedRuntimePermissionCases = [
  { name: "null", value: null },
  { name: "undefined", value: undefined },
  { name: "string", value: "contents:read" },
  { name: "array", value: [] },
  { name: "undefined level", value: { contents: undefined } },
  { name: "unknown level", value: { contents: "maintain" } },
  { name: "non-string level", value: { contents: 1 } },
  {
    name: "inherited permission",
    value: Object.assign(Object.create({ contents: "read" }), { actions: "read" }),
  },
  {
    name: "accessor permission",
    value: Object.defineProperty({}, "contents", { enumerable: true, get: () => "read" }),
  },
  { name: "symbol permission", value: { contents: "read", [Symbol("unknown")]: "write" } },
];

describe("InstallationAccessTokenRequest normalization", () => {
  it("creates an immutable request snapshot and derives its representations", () => {
    const permissions = { pull_requests: "read", actions: "write" } as const;
    const tokenRequest = createInstallationAccessTokenRequest({
      owner: "fixture-owner",
      permissions,
      repository: "fixture-source-repository",
    });

    (permissions as { pull_requests: "read" | "write" }).pull_requests = "write";

    expect(tokenRequest).toEqual({
      permissions: { actions: "write", pull_requests: "read" },
      resource: {
        href: fixtureSourceResource,
        owner: "fixture-owner",
        repository: "fixture-source-repository",
      },
      scope: "actions:write pull_requests:read",
    });
    expect(Object.isFrozen(tokenRequest)).toBe(true);
    expect(Object.isFrozen(tokenRequest.permissions)).toBe(true);
    expect(Object.isFrozen(tokenRequest.resource)).toBe(true);
  });

  it("rejects an empty Requested Permissions map", () => {
    expect(() =>
      createInstallationAccessTokenRequest({
        owner: "fixture-owner",
        permissions: {},
        repository: "fixture-source-repository",
      }),
    ).toThrow(TypeError);
  });

  it.each([
    {
      expectedPermissions: { contents: "write", pull_requests: "write" },
      expectedScope: "contents:write pull_requests:write",
      name: "reordered permissions",
      scope: "pull_requests:write contents:write",
    },
    {
      expectedPermissions: { contents: "write", pull_requests: "write" },
      expectedScope: "contents:write pull_requests:write",
      name: "duplicate permissions",
      scope: "contents:write contents:write pull_requests:write",
    },
    {
      expectedPermissions: { actions: "read", issues: "admin", pull_requests: "write" },
      expectedScope: "actions:read issues:admin pull_requests:write",
      name: "arbitrary permission names and all explicit levels",
      scope: "pull_requests:write issues:admin actions:read",
    },
  ] as const)("normalizes $name", ({ expectedPermissions, expectedScope, scope }) => {
    const tokenRequest = mustNormalizeTokenRequest({
      resource: fixtureSourceResource,
      scope,
    });

    expect(tokenRequest).toEqual({
      permissions: expectedPermissions,
      resource: {
        href: fixtureSourceResource,
        owner: "fixture-owner",
        repository: "fixture-source-repository",
      },
      scope: expectedScope,
    });
  });

  it.each([
    "fixture-target-owner/fixture-target-repository",
    " https://api.github.com/repos/fixture-target-owner/fixture-target-repository",
    "https://api.github.com/repos/fixture-target-owner/fixture-target-repository ",
    "https://github.com/fixture-target-owner/fixture-target-repository",
    "https://api.github.com/repos/fixture-target-owner/fixture-target-repository/",
    "https://api.github.com/repos/fixture-target-owner/fixture-target-repository?x=1",
    "https://api.github.com/repos/fixture-target-owner/fixture-target-repository#fragment",
    "https://user@api.github.com/repos/fixture-target-owner/fixture-target-repository",
    "https://api.github.com/repos/fixture-target-owner%2Ffixture-other-target/fixture-target-repository",
    "https://api.github.com/repos/fixture-target-owner/../fixture-target-repository",
    "https://api.github.com/repos/fixture-target-owner/fixture-target-repository/actions/workflows/x.yml",
  ])("rejects non-canonical resource %s", (resource) => {
    expect(
      normalizeInstallationAccessTokenRequest({
        resource,
        scope: "actions:write",
      }),
    ).toEqual({
      error: "invalid_target",
      ok: false,
    });
  });

  it.each([
    null,
    "",
    " ",
    " actions:write",
    "actions:write ",
    "contents:write  pull_requests:write",
    "contents:write\tpull_requests:write",
    "contents:write\npull_requests:write",
    "contents:read contents:write",
    "contents:read:write",
    ":read",
    'bad"name:read',
    "bad\\name:read",
    "ümlaut:read",
    "contents:maintain",
    "actions",
  ])("rejects missing or unsupported scope %s", (scope) => {
    expect(
      normalizeInstallationAccessTokenRequest({
        resource: fixtureTargetResource,
        scope,
      }),
    ).toEqual({
      error: "invalid_scope",
      ok: false,
    });
  });
});

describe("GitHub installation permission domain", () => {
  it.each([
    ["actions", "read"],
    ["actions", "write"],
    ["issues", "admin"],
    ["future_permission", "read"],
  ] as const)("accepts structurally valid permission %s:%s", (name, level) => {
    expect(installationAccessTokenPermissionsAreValid({ [name]: level })).toBe(true);
  });

  it.each([
    [undefined, "read", false],
    [undefined, "write", false],
    [undefined, "admin", false],
    ["read", "read", true],
    ["read", "write", false],
    ["read", "admin", false],
    ["write", "read", true],
    ["write", "write", true],
    ["write", "admin", false],
    ["admin", "read", true],
    ["admin", "write", true],
    ["admin", "admin", true],
  ] as const)("reports whether %s covers %s", (configured, requested, expected) => {
    expect(installationAccessTokenPermissionLevelCovers(configured, requested)).toBe(expected);
  });

  it.each([{ name: "empty object", value: {} }, ...malformedRuntimePermissionCases])(
    "rejects unsupported runtime permission data: $name",
    ({ value }) => {
      expect(installationAccessTokenPermissionsAreValid(value)).toBe(false);
    },
  );

  it.each(malformedRuntimePermissionCases)(
    "does not canonicalize malformed runtime permission data: $name",
    ({ value }) => {
      expect(() => canonicalizeInstallationAccessTokenPermissions(value as never)).toThrow(
        TypeError,
      );
    },
  );

  it("canonicalizes an empty internal permission set", () => {
    const permissions = canonicalizeInstallationAccessTokenPermissions({});

    expect(permissions).toEqual({});
  });

  it("copies permission data without retaining its source object", () => {
    const source = { pull_requests: "read", actions: "write" } as const;
    const permissions = canonicalizeInstallationAccessTokenPermissions(source);

    expect(permissions).toEqual({ actions: "write", pull_requests: "read" });
    expect(permissions).not.toBe(source);
  });
});

describe("GitHub Repository Resource domain", () => {
  it.each(["owner", "Owner.Name", "repository_name", "repository.git", "owner-123"])(
    "accepts a canonical path segment %s",
    (value) => {
      expect(isGitHubRepositoryResourcePathSegment(value)).toBe(true);
    },
  );

  it.each([undefined, null, "", ".", "..", "owner/name", "repository%2Fname"])(
    "rejects a non-canonical path segment %s",
    (value) => {
      expect(isGitHubRepositoryResourcePathSegment(value)).toBe(false);
    },
  );

  it.each([
    ["owner", "repository"],
    ["Owner.Name", "Repository_Name"],
    ["owner-123", "repository.git"],
  ])("constructs and parses canonical resource %s/%s", (owner, repository) => {
    const resource = createGitHubRepositoryResource({ owner, repository });

    expect(resource).toEqual({
      href: `https://api.github.com/repos/${owner}/${repository}`,
      owner,
      repository,
    });
    expect(parseGitHubRepositoryResource(resource.href)).toEqual(resource);
  });

  it.each([
    [".", "repository"],
    ["..", "repository"],
    ["owner", "."],
    ["owner", ".."],
  ])("rejects dot segment resource %s/%s", (owner, repository) => {
    expect(() => createGitHubRepositoryResource({ owner, repository })).toThrow(TypeError);
  });

  it.each([
    ["", "repository"],
    ["owner/name", "repository"],
    ["owner", ""],
    ["owner", "repository/name"],
    ["owner", "repository%2Fname"],
  ])("rejects unsupported resource syntax %s/%s", (owner, repository) => {
    expect(() => createGitHubRepositoryResource({ owner, repository })).toThrow(TypeError);
  });

  it("requires canonical API host casing", () => {
    expect(
      parseGitHubRepositoryResource("https://API.GITHUB.COM/repos/Owner/Repository"),
    ).toBeNull();
    expect(parseGitHubRepositoryResource("https://api.github.com/repos/Owner/Repository")).toEqual({
      href: "https://api.github.com/repos/Owner/Repository",
      owner: "Owner",
      repository: "Repository",
    });
  });
});
