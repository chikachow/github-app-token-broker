export type GitHubInstallationPermissionLevel = "admin" | "read" | "write";

export type GitHubInstallationPermissions = Readonly<
  Record<string, GitHubInstallationPermissionLevel>
>;

export interface InstallationAccessTokenRequest {
  readonly permissions: GitHubInstallationPermissions;
  readonly resource: GitHubRepositoryResource;
  readonly scope: string;
}

export interface GitHubRepositoryResource {
  readonly href: string;
  readonly owner: string;
  readonly repository: string;
}

export function isGitHubRepositoryResourcePathSegment(value: unknown): value is string {
  return (
    typeof value === "string" && value !== "." && value !== ".." && /^[A-Za-z0-9_.-]+$/u.test(value)
  );
}

const supportedPermissionLevels = new Set<GitHubInstallationPermissionLevel>([
  "admin",
  "read",
  "write",
]);
const permissionLevelRanks: Readonly<Record<GitHubInstallationPermissionLevel, number>> = {
  admin: 3,
  read: 1,
  write: 2,
};

export function normalizeInstallationAccessTokenRequest(options: {
  resource: string;
  scope: string | null;
}): { ok: true; tokenRequest: InstallationAccessTokenRequest } | { error: string; ok: false } {
  const resource = parseGitHubRepositoryResource(options.resource);

  if (resource === null) {
    return { error: "invalid_target", ok: false };
  }

  const scope = options.scope === null ? null : parseGitHubInstallationScope(options.scope);

  if (scope === null) {
    return { error: "invalid_scope", ok: false };
  }

  return {
    ok: true,
    tokenRequest: {
      permissions: scope.permissions,
      resource,
      scope: scope.scope,
    },
  };
}

export function parseGitHubRepositoryResource(value: string): GitHubRepositoryResource | null {
  if (value.length === 0) {
    return null;
  }

  let resource: URL;

  try {
    resource = new URL(value);
  } catch {
    return null;
  }

  if (
    resource.href !== value ||
    resource.protocol !== "https:" ||
    resource.hostname !== "api.github.com" ||
    resource.port.length !== 0 ||
    resource.username.length !== 0 ||
    resource.password.length !== 0 ||
    resource.search.length !== 0 ||
    resource.hash.length !== 0
  ) {
    return null;
  }

  const parts = resource.pathname.split("/");

  if (
    parts.length !== 4 ||
    parts[0] !== "" ||
    parts[1] !== "repos" ||
    !isGitHubRepositoryResourcePathSegment(parts[2]) ||
    !isGitHubRepositoryResourcePathSegment(parts[3])
  ) {
    return null;
  }

  return Object.freeze({
    href: resource.href,
    owner: parts[2],
    repository: parts[3],
  });
}

export function createGitHubRepositoryResource(options: {
  readonly owner: string;
  readonly repository: string;
}): GitHubRepositoryResource {
  if (
    !isGitHubRepositoryResourcePathSegment(options.owner) ||
    !isGitHubRepositoryResourcePathSegment(options.repository)
  ) {
    throw new TypeError("invalid GitHub Repository Resource path segment");
  }

  const resource = parseGitHubRepositoryResource(
    `https://api.github.com/repos/${options.owner}/${options.repository}`,
  );

  if (
    resource === null ||
    resource.owner !== options.owner ||
    resource.repository !== options.repository
  ) {
    throw new TypeError("GitHub Repository Resource does not round-trip canonically");
  }

  return resource;
}

export function installationAccessTokenPermissionsAreValid(
  permissions: unknown,
): permissions is GitHubInstallationPermissions {
  return validatedPermissionEntries(permissions, false) !== null;
}

export function canonicalizeInstallationAccessTokenPermissions(
  permissions: GitHubInstallationPermissions,
): GitHubInstallationPermissions {
  const entries = validatedPermissionEntries(permissions, true);

  if (entries === null) {
    throw new TypeError("invalid GitHub installation permissions");
  }

  return Object.freeze(Object.fromEntries(entries.sort(comparePermissionEntry)));
}

export function installationAccessTokenPermissionLevelCovers(
  configured: GitHubInstallationPermissionLevel | undefined,
  requested: GitHubInstallationPermissionLevel,
): boolean {
  return (
    configured !== undefined && permissionLevelRanks[configured] >= permissionLevelRanks[requested]
  );
}

export function unionGitHubInstallationPermissions(
  left: GitHubInstallationPermissions,
  right: GitHubInstallationPermissions,
): GitHubInstallationPermissions {
  const permissions: Record<string, GitHubInstallationPermissionLevel> = Object.create(null);

  for (const name of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const leftLevel = Object.hasOwn(left, name) ? left[name] : undefined;
    const rightLevel = Object.hasOwn(right, name) ? right[name] : undefined;

    if (leftLevel === undefined) {
      if (rightLevel !== undefined) {
        permissions[name] = rightLevel;
      }
    } else if (
      rightLevel === undefined ||
      permissionLevelRanks[leftLevel] >= permissionLevelRanks[rightLevel]
    ) {
      permissions[name] = leftLevel;
    } else {
      permissions[name] = rightLevel;
    }
  }

  return canonicalizeInstallationAccessTokenPermissions(permissions);
}

function parseGitHubInstallationScope(
  value: string,
): { permissions: GitHubInstallationPermissions; scope: string } | null {
  const scopeTokens = value.split(" ");

  if (scopeTokens.some((scope) => scope.length === 0)) {
    return null;
  }

  const permissions: Record<string, GitHubInstallationPermissionLevel> = Object.create(null);
  const seen = new Set<string>();

  for (const scope of scopeTokens) {
    const permission = parseGitHubInstallationPermissionScope(scope);

    if (permission === undefined) {
      return null;
    }

    if (seen.has(scope)) {
      continue;
    }

    const [name, level] = permission;

    if (permissions[name] !== undefined) {
      return null;
    }

    permissions[name] = level;
    seen.add(scope);
  }

  return {
    permissions: canonicalizeInstallationAccessTokenPermissions(permissions),
    scope: [...seen].sort(compareStrings).join(" "),
  };
}

function comparePermissionEntry(
  [left]: readonly [string, string],
  [right]: readonly [string, string],
): number {
  return compareStrings(left, right);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validatedPermissionEntries(
  permissions: unknown,
  allowEmpty: boolean,
): [string, GitHubInstallationPermissionLevel][] | null {
  if (
    typeof permissions !== "object" ||
    permissions === null ||
    Array.isArray(permissions) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(permissions)) ||
    Object.getOwnPropertySymbols(permissions).length > 0
  ) {
    return null;
  }

  const descriptors = Object.getOwnPropertyDescriptors(permissions);
  const names = Object.getOwnPropertyNames(permissions);

  if (!allowEmpty && names.length === 0) {
    return null;
  }

  const entries: [string, GitHubInstallationPermissionLevel][] = [];

  for (const name of names) {
    const descriptor = descriptors[name];

    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !isOAuthScopePermissionName(name) ||
      !supportedPermissionLevels.has(descriptor.value as GitHubInstallationPermissionLevel)
    ) {
      return null;
    }

    entries.push([name, descriptor.value as GitHubInstallationPermissionLevel]);
  }

  return entries;
}

function parseGitHubInstallationPermissionScope(
  scope: string,
): readonly [string, GitHubInstallationPermissionLevel] | undefined {
  const separator = scope.indexOf(":");

  if (separator <= 0 || separator !== scope.lastIndexOf(":")) {
    return undefined;
  }

  const name = scope.slice(0, separator);
  const level = scope.slice(separator + 1);

  return isOAuthScopePermissionName(name) &&
    supportedPermissionLevels.has(level as GitHubInstallationPermissionLevel)
    ? [name, level as GitHubInstallationPermissionLevel]
    : undefined;
}

function isOAuthScopePermissionName(name: string): boolean {
  if (name.length === 0) {
    return false;
  }

  for (const character of name) {
    const codePoint = character.codePointAt(0);

    if (
      codePoint === undefined ||
      codePoint === 0x3a ||
      !(
        codePoint === 0x21 ||
        (codePoint >= 0x23 && codePoint <= 0x5b) ||
        (codePoint >= 0x5d && codePoint <= 0x7e)
      )
    ) {
      return false;
    }
  }

  return true;
}
