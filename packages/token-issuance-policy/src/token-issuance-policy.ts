import {
  parseOidcIssuerIdentifier,
  type OidcIssuerIdentifier,
  type OidcProviderRegistration,
} from "@github-app-token-broker/oidc/provider-registration";
import {
  createGitHubRepositoryResource,
  installationAccessTokenPermissionsAreValid,
  installationAccessTokenPermissionLevelCovers,
  isGitHubRepositoryResourcePathSegment,
  type GitHubInstallationPermissionLevel,
  type GitHubInstallationPermissions,
  type InstallationAccessTokenRequest,
  type GitHubRepositoryResource,
} from "@github-app-token-broker/github/installation-access-token-request";
import type { VerifiedSubjectToken } from "@github-app-token-broker/oidc/id-token-authenticator";

export type ClaimPredicateDefinition =
  | Readonly<{
      claimName: string;
      expectedValue: string | boolean;
      kind: "claim-equals";
    }>
  | Readonly<{
      claimName: string;
      expectedValues: readonly [string, ...string[]];
      kind: "claim-one-of";
    }>;

export interface OidcSubjectTokenConstraintDefinition {
  readonly claimPredicates: readonly ClaimPredicateDefinition[];
  readonly issuer: OidcIssuerIdentifier;
}

export interface GitHubRepositoryResourceConstraintDefinition {
  readonly owner: string;
  readonly repository: string;
}

export interface GitHubRepositoryOwnerResourceConstraintDefinition {
  readonly owner: string;
  /** null selects every repository owned by owner. */
  readonly repository: null;
}

type GitHubRepositoryResourceConstraint =
  | GitHubRepositoryResourceConstraintDefinition
  | GitHubRepositoryOwnerResourceConstraintDefinition;

export interface PermitStatementDefinition {
  readonly permissions: GitHubInstallationPermissions;
  readonly resource: GitHubRepositoryResourceConstraint;
  readonly subjectToken: OidcSubjectTokenConstraintDefinition;
}

interface ClaimEqualsPredicate {
  readonly claimName: string;
  readonly expectedValue: string | boolean;
  readonly kind: "claim-equals";
}

interface ClaimOneOfPredicate {
  readonly claimName: string;
  readonly expectedValues: readonly [string, ...string[]];
  readonly kind: "claim-one-of";
}

type ClaimPredicate = ClaimEqualsPredicate | ClaimOneOfPredicate;

interface OidcSubjectTokenConstraint {
  readonly claimPredicates: readonly ClaimPredicate[];
  readonly issuer: OidcIssuerIdentifier;
}

interface PermitStatement {
  readonly permissions: GitHubInstallationPermissions;
  readonly resource: GitHubRepositoryResourceConstraint;
  readonly subjectToken: OidcSubjectTokenConstraint;
}

export interface TokenIssuancePolicy {
  readonly permitStatements: readonly PermitStatement[];
}

export type TokenIssuancePolicyEvaluation =
  | Readonly<{ outcome: "permitted" }>
  | Readonly<{ outcome: "requested_permissions_unsupported" }>
  | Readonly<{ outcome: "subject_token_unacceptable" }>
  | Readonly<{ outcome: "target_unsupported" }>;

const permittedEvaluation = Object.freeze({ outcome: "permitted" } as const);
const requestedPermissionsUnsupportedEvaluation = Object.freeze({
  outcome: "requested_permissions_unsupported",
} as const);
const subjectTokenUnacceptableEvaluation = Object.freeze({
  outcome: "subject_token_unacceptable",
} as const);
const targetUnsupportedEvaluation = Object.freeze({ outcome: "target_unsupported" } as const);

export function claimEquals(
  claimName: string,
  expectedValue: string | boolean,
): ClaimPredicateDefinition {
  if (typeof claimName !== "string") {
    throw new TypeError("claimEquals.claimName must be a string");
  }

  if (typeof expectedValue !== "string" && typeof expectedValue !== "boolean") {
    throw new TypeError("claimEquals.expectedValue must be a string or Boolean");
  }

  return Object.freeze({ claimName, expectedValue, kind: "claim-equals" });
}

export function claimOneOf(
  claimName: string,
  expectedValues: readonly string[],
): ClaimPredicateDefinition {
  if (typeof claimName !== "string") {
    throw new TypeError("claimOneOf.claimName must be a string");
  }

  const values = readArray(expectedValues, "claimOneOf.expectedValues");

  if (values.length === 0) {
    throw new TypeError("claimOneOf.expectedValues must not be empty");
  }

  if (values.some((value) => typeof value !== "string")) {
    throw new TypeError("claimOneOf.expectedValues must contain only strings");
  }

  if (new Set(values).size !== values.length) {
    throw new TypeError("claimOneOf.expectedValues must not contain duplicates");
  }

  return Object.freeze({
    claimName,
    expectedValues: Object.freeze([...values]) as readonly [string, ...string[]],
    kind: "claim-one-of",
  });
}

export function oidcSubjectTokenConstraint(
  issuer: OidcIssuerIdentifier,
  ...claimPredicates: readonly ClaimPredicateDefinition[]
): OidcSubjectTokenConstraintDefinition {
  const parsedIssuer = typeof issuer === "string" ? parseOidcIssuerIdentifier(issuer) : null;

  if (parsedIssuer === null) {
    throw new TypeError("oidcSubjectTokenConstraint.issuer is invalid");
  }

  const normalizedPredicates = normalizeClaimPredicates(
    claimPredicates,
    "oidcSubjectTokenConstraint.claimPredicates",
  );

  return Object.freeze({
    claimPredicates: normalizedPredicates,
    issuer: parsedIssuer,
  });
}

export function githubRepositoryResourceConstraint(
  owner: string,
  repository: string,
): GitHubRepositoryResourceConstraintDefinition {
  const resource = createGitHubRepositoryResource({ owner, repository });

  return Object.freeze({ owner: resource.owner, repository: resource.repository });
}

export function githubRepositoryOwnerResourceConstraint(
  owner: string,
): GitHubRepositoryOwnerResourceConstraintDefinition {
  if (!isGitHubRepositoryResourcePathSegment(owner)) {
    throw new TypeError("invalid GitHub Repository Resource owner");
  }

  return Object.freeze({ owner, repository: null });
}

export function compileTokenIssuancePolicy(
  permitStatements: readonly PermitStatementDefinition[],
): TokenIssuancePolicy {
  const definitions = readArray(permitStatements, "permitStatements");
  const statements = Object.freeze(
    definitions.map((definition, index) =>
      compilePermitStatement(definition, `permitStatements[${index}]`),
    ),
  );
  return Object.freeze({ permitStatements: statements });
}

export function evaluateTokenIssuancePolicy(
  policy: TokenIssuancePolicy,
  verifiedSubjectToken: VerifiedSubjectToken,
  request: InstallationAccessTokenRequest,
): TokenIssuancePolicyEvaluation {
  const permissionsNotCoveredForResource = new Set(
    Object.keys(request.permissions) as (keyof GitHubInstallationPermissions)[],
  );
  const permissionsNotCoveredForMatchingSubject = new Set(permissionsNotCoveredForResource);
  let targetSupported = false;

  for (const statement of policy.permitStatements) {
    if (!resourceConstraintMatches(statement.resource, request.resource)) {
      continue;
    }

    targetSupported = true;
    removeCoveredPermissions(
      permissionsNotCoveredForResource,
      statement.permissions,
      request.permissions,
    );

    if (
      statement.subjectToken.issuer === verifiedSubjectToken.issuer &&
      claimPredicatesMatch(statement.subjectToken.claimPredicates, verifiedSubjectToken.claims)
    ) {
      removeCoveredPermissions(
        permissionsNotCoveredForMatchingSubject,
        statement.permissions,
        request.permissions,
      );

      if (permissionsNotCoveredForMatchingSubject.size === 0) {
        return permittedEvaluation;
      }
    }
  }

  return !targetSupported
    ? targetUnsupportedEvaluation
    : permissionsNotCoveredForResource.size > 0
      ? requestedPermissionsUnsupportedEvaluation
      : subjectTokenUnacceptableEvaluation;
}

function resourceConstraintMatches(
  constraint: GitHubRepositoryResourceConstraint,
  resource: GitHubRepositoryResource,
): boolean {
  return (
    constraint.owner === resource.owner &&
    (constraint.repository === null || constraint.repository === resource.repository)
  );
}

function removeCoveredPermissions(
  uncoveredPermissions: Set<keyof GitHubInstallationPermissions>,
  configuredPermissions: GitHubInstallationPermissions,
  requestedPermissions: GitHubInstallationPermissions,
): void {
  for (const permissionName of uncoveredPermissions) {
    const requestedLevel = requestedPermissions[permissionName];

    if (
      requestedLevel !== undefined &&
      installationAccessTokenPermissionLevelCovers(
        configuredPermissions[permissionName],
        requestedLevel,
      )
    ) {
      uncoveredPermissions.delete(permissionName);
    }
  }
}

export function assertTokenIssuancePolicyIssuersAreRegistered(
  policy: TokenIssuancePolicy,
  providerRegistrations: readonly OidcProviderRegistration[],
): void {
  const registeredIssuers = new Set(
    providerRegistrations.map((providerRegistration) => providerRegistration.issuer),
  );
  const missingIssuers = [
    ...new Set(
      policy.permitStatements
        .map((statement) => statement.subjectToken.issuer)
        .filter((issuer) => !registeredIssuers.has(issuer)),
    ),
  ].sort();

  if (missingIssuers.length > 0) {
    throw new TypeError(
      `Token Issuance Policy references unregistered OIDC Issuer Identifiers: ${missingIssuers.join(
        ", ",
      )}`,
    );
  }
}

function compilePermitStatement(value: unknown, path: string): PermitStatement {
  const statement = readExactObject(value, path, ["permissions", "resource", "subjectToken"]);
  const subjectToken = readExactObject(statement["subjectToken"], `${path}.subjectToken`, [
    "claimPredicates",
    "issuer",
  ]);
  const issuer =
    typeof subjectToken["issuer"] === "string"
      ? parseOidcIssuerIdentifier(subjectToken["issuer"])
      : null;

  if (issuer === null) {
    fail(`${path}.subjectToken.issuer`, "must be an exact OIDC Issuer Identifier");
  }

  const claimPredicates = normalizeClaimPredicates(
    subjectToken["claimPredicates"],
    `${path}.subjectToken.claimPredicates`,
  );
  const resourceDefinition = readExactObject(statement["resource"], `${path}.resource`, [
    "owner",
    "repository",
  ]);

  if (typeof resourceDefinition["owner"] !== "string") {
    fail(`${path}.resource.owner`, "must be a string");
  }

  if (
    resourceDefinition["repository"] !== null &&
    typeof resourceDefinition["repository"] !== "string"
  ) {
    fail(`${path}.resource.repository`, "must be a string or null");
  }

  let resource: GitHubRepositoryResourceConstraint;

  try {
    resource =
      resourceDefinition["repository"] === null
        ? githubRepositoryOwnerResourceConstraint(resourceDefinition["owner"])
        : githubRepositoryResourceConstraint(
            resourceDefinition["owner"],
            resourceDefinition["repository"],
          );
  } catch {
    fail(`${path}.resource`, "must identify a canonical GitHub Repository Resource Constraint");
  }

  const permissions = compilePermissions(statement["permissions"], `${path}.permissions`);

  return Object.freeze({
    permissions,
    resource,
    subjectToken: Object.freeze({ claimPredicates, issuer }),
  });
}

function normalizeClaimPredicates(value: unknown, path: string): readonly ClaimPredicate[] {
  const definitions = readArray(value, path);
  const claimNames = new Set<string>();
  const predicates = definitions.map((definition, index) => {
    const predicatePath = `${path}[${index}]`;
    const base = readExactObjectWithDiscriminant(definition, predicatePath, "kind", {
      "claim-equals": ["claimName", "expectedValue", "kind"],
      "claim-one-of": ["claimName", "expectedValues", "kind"],
    });

    if (typeof base["claimName"] !== "string") {
      fail(`${predicatePath}.claimName`, "must be a string");
    }

    if (claimNames.has(base["claimName"])) {
      fail(predicatePath, `repeats Claim Name ${JSON.stringify(base["claimName"])}`);
    }

    claimNames.add(base["claimName"]);

    if (base.kind === "claim-equals") {
      if (typeof base["expectedValue"] !== "string" && typeof base["expectedValue"] !== "boolean") {
        fail(`${predicatePath}.expectedValue`, "must be a string or Boolean");
      }

      return Object.freeze({
        claimName: base["claimName"],
        expectedValue: base["expectedValue"],
        kind: base.kind,
      });
    }

    const expectedValues = readArray(base["expectedValues"], `${predicatePath}.expectedValues`);

    if (expectedValues.length === 0) {
      fail(`${predicatePath}.expectedValues`, "must not be empty");
    }

    if (expectedValues.some((expectedValue) => typeof expectedValue !== "string")) {
      fail(`${predicatePath}.expectedValues`, "must contain only strings");
    }

    if (new Set(expectedValues).size !== expectedValues.length) {
      fail(`${predicatePath}.expectedValues`, "must not contain duplicates");
    }

    return Object.freeze({
      claimName: base["claimName"],
      expectedValues: Object.freeze([...expectedValues]) as readonly [string, ...string[]],
      kind: base.kind,
    });
  });

  return Object.freeze(predicates);
}

function claimPredicatesMatch(
  predicates: readonly ClaimPredicate[],
  claims: Readonly<Record<string, unknown>>,
): boolean {
  return predicates.every((predicate) => {
    if (!Object.hasOwn(claims, predicate.claimName)) {
      return false;
    }

    const claimValue = claims[predicate.claimName];

    if (predicate.kind === "claim-equals") {
      return claimValue === predicate.expectedValue;
    }

    return (
      typeof claimValue === "string" &&
      predicate.expectedValues.some((expectedValue) => expectedValue === claimValue)
    );
  });
}

function compilePermissions(value: unknown, path: string): GitHubInstallationPermissions {
  const permissions = readObject(value, path);
  const names = Object.getOwnPropertyNames(permissions);

  if (names.length === 0) {
    fail(path, "must not be empty");
  }

  const entries: [string, GitHubInstallationPermissionLevel][] = [];

  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(permissions, name);

    if (descriptor === undefined || !("value" in descriptor)) {
      fail(`${path}.${name}`, "must be an own data field");
    }

    const permission = { [name]: descriptor.value };

    if (!installationAccessTokenPermissionsAreValid(permission)) {
      fail(`${path}.${name}`, "has an invalid permission name or level");
    }

    entries.push([name, permission[name] as GitHubInstallationPermissionLevel]);
  }

  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return Object.freeze(Object.fromEntries(entries));
}

function readExactObject(
  value: unknown,
  path: string,
  expectedFields: readonly string[],
): Record<string, unknown> {
  const object = readObject(value, path);
  const names = Object.getOwnPropertyNames(object);

  for (const name of names) {
    if (!expectedFields.includes(name)) {
      fail(`${path}.${name}`, "is an unknown field");
    }
  }

  for (const field of expectedFields) {
    const descriptor = Object.getOwnPropertyDescriptor(object, field);

    if (descriptor === undefined) {
      fail(`${path}.${field}`, "is required");
    }

    if (!("value" in descriptor)) {
      fail(`${path}.${field}`, "must be an own data field");
    }
  }

  return object;
}

function readExactObjectWithDiscriminant<
  Variants extends Readonly<Record<string, readonly string[]>>,
>(
  value: unknown,
  path: string,
  discriminant: string,
  variants: Variants,
): Record<string, unknown> & { kind: keyof Variants } {
  const object = readObject(value, path);
  const discriminantDescriptor = Object.getOwnPropertyDescriptor(object, discriminant);

  if (discriminantDescriptor === undefined || !("value" in discriminantDescriptor)) {
    fail(`${path}.${discriminant}`, "must be an own data field");
  }

  if (
    typeof discriminantDescriptor.value !== "string" ||
    !Object.hasOwn(variants, discriminantDescriptor.value)
  ) {
    fail(`${path}.${discriminant}`, "has an unsupported discriminant");
  }

  return readExactObject(
    object,
    path,
    variants[discriminantDescriptor.value] as readonly string[],
  ) as Record<string, unknown> & { kind: keyof Variants };
}

function readObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }

  const prototype = Object.getPrototypeOf(value);

  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, "must not contain inherited fields");
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail(path, "must not contain symbol fields");
  }

  return value as Record<string, unknown>;
}

function readArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(path, "must be an array");
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail(path, "must not contain symbol fields");
  }

  const values: unknown[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));

    if (descriptor === undefined || !("value" in descriptor)) {
      fail(`${path}[${index}]`, "must be an own data element");
    }

    values.push(descriptor.value);
  }

  for (const name of Object.getOwnPropertyNames(value)) {
    if (
      name !== "length" &&
      (!/^(?:0|[1-9][0-9]*)$/u.test(name) ||
        !Number.isSafeInteger(Number(name)) ||
        Number(name) >= value.length)
    ) {
      fail(`${path}.${name}`, "is an unknown array field");
    }
  }

  return values;
}

function fail(path: string, message: string): never {
  throw new TypeError(`${path} ${message}`);
}
