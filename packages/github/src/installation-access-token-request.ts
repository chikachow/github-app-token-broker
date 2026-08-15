export type GitHubInstallationPermissionLevel = "admin" | "read" | "write";

export type GitHubInstallationPermissions = Readonly<
  Record<string, GitHubInstallationPermissionLevel>
>;

const installationAccessTokenRequestBrand: unique symbol = Symbol("InstallationAccessTokenRequest");

export interface InstallationAccessTokenRequest {
  readonly permissions: GitHubInstallationPermissions;
  readonly resource: GitHubRepositoryResource;
  readonly scope: string;
  readonly [installationAccessTokenRequestBrand]: true;
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

  const permissions = options.scope === null ? null : parseGitHubInstallationScope(options.scope);

  if (permissions === null) {
    return { error: "invalid_scope", ok: false };
  }

  return {
    ok: true,
    tokenRequest: createInstallationAccessTokenRequest({
      owner: resource.owner,
      permissions,
      repository: resource.repository,
    }),
  };
}

export function createInstallationAccessTokenRequest(options: {
  readonly owner: string;
  readonly permissions: GitHubInstallationPermissions;
  readonly repository: string;
}): InstallationAccessTokenRequest {
  const permissions = canonicalizeInstallationAccessTokenPermissions(options.permissions);

  if (Object.keys(permissions).length === 0) {
    throw new TypeError("Requested Permissions must not be empty");
  }

  const resource = createGitHubRepositoryResource({
    owner: options.owner,
    repository: options.repository,
  });
  const request = {
    permissions,
    resource,
    get scope(): string {
      return Object.entries(permissions)
        .map(([name, level]) => `${name}:${level}`)
        .join(" ");
    },
  };

  Object.defineProperty(request, installationAccessTokenRequestBrand, { value: true });

  return Object.freeze(request) as InstallationAccessTokenRequest;
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

  return createGitHubRepositoryResource({ owner: parts[2], repository: parts[3] });
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

  const { owner, repository } = options;

  return Object.freeze({
    get href(): string {
      return `https://api.github.com/repos/${owner}/${repository}`;
    },
    owner,
    repository,
  });
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

function parseGitHubInstallationScope(value: string): GitHubInstallationPermissions | null {
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

  return permissions;
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
