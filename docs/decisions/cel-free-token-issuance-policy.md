# CEL-free Token Issuance Policy

## Status

Decision status: Accepted.

Decision scope: This record defines authorization-model capabilities, not any
deployment's Permit Statement inventory. Conditional examples describe what a
reviewed application composition can express. A deployment-owned TypeScript
composition and its tests record the inventory compiled into that artifact.

## Context

The Token Exchange service authorizes one operation: issuing an Installation
Access Token for a normalized Installation Access Token Request
presented with a Verified Subject Token.

The former CEL policy combined structural issuer, resource, and permission
fields with CEL expressions over Subject Token Claims. CEL admitted
substantially more syntax, types, and operations than reviewed policies needed.
It also required a parser, planner, binding adapter, compilation cache, runtime
error handling, and tests for expression-language behavior outside the
authorization domain.

The former model assigned identifiers to allow-only rules and returned a
matched rule or synthesized denial reasons. No caller selected a rule, rule
order had no intended meaning, and no single unmet dimension generally
explained why the complete request was not permitted.

## Decision

### Domain language

The canonical terms in this decision are defined in the [github-app-token-broker domain
glossary](../../CONTEXT.md). This decision uses those terms rather than defining
a second authorization vocabulary.

The entry is a **Permit Statement**, not a grant or rule. OAuth defines an
authorization grant as a protocol credential, while this entry is reviewed
build-time authorization configuration. The entry has neither a selectable
effect nor an identifier-bearing rule-combining role.

The policy input remains a **Verified Subject Token**, following the RFC 8693
`subject_token` role. The design does not construct an application Principal.
OIDC **Subject Identifier** remains reserved for the issuer-local `sub` Claim.

### Closed policy language

Token Issuance Policy uses a closed, immutable TypeScript authoring language
made of Permit Statements. Each statement contains:

- one issuer-qualified OIDC Subject Token Constraint;
- one Repository Resource Constraint, selecting either one exact repository or
  every repository owned by one owner; and
- one non-empty GitHub installation permission map.

Permission names are not a closed github-app-token-broker catalogue. They are structurally
valid OAuth scope-token components, while permission levels form the closed
ordered set `read`, `write`, and `admin`; GitHub remains authoritative for
which names accept which levels.

OIDC Subject Token Constraints contain one exact OIDC Issuer Identifier and
zero or more typed Claim Predicates. The initial predicates are strict
string-or-Boolean equality and membership in a finite string set. Matching uses
own-property lookup and performs no coercion, normalization, path traversal,
regular-expression evaluation, or Claim-to-Claim comparison.

OIDC Subject Token Constraints and Repository Resource Constraints are separate
typed products. Claim Predicates form the only discriminated AST union. Permit Statements remain
plain objects without identifiers, effects, action fields, generic conditions,
or a `permit(...)` wrapper.

A Repository Resource Constraint contains a canonical GitHub owner and either a
canonical repository name or `repository: null`. A repository name matches only
that repository; `null` matches every repository under the owner. The request
itself always contains one exact canonical Repository Resource, and an
owner-scoped constraint never matches a different owner.

### Applicability and Effective Permissions

A Permit Statement is applicable when its complete OIDC Subject Token Constraint
and Repository Resource Constraint match, including the constraint's exact or
owner-scoped repository selection. Only an applicable statement contributes
its `permissions`. The policy never combines issuers, Claim Predicates, or
Repository Resource Constraints across statements.

Applicable permissions combine pointwise using:

```text
omitted < read < write < admin
```

The result is the Effective Permissions. The policy permits issuance when the
Effective Permissions cover the Requested Permissions at equal or stronger
levels. The exact Requested Permissions map is sent to GitHub unchanged.

Authorization of Requested Permissions is separable. For the same Verified
Subject Token and Repository Resource:

```text
permits(P ∪ Q) iff permits(P) and permits(Q)
```

Here `∪` is pointwise union. There is no meaningful authorization distinction
between one token carrying two independently permitted permissions and two
tokens carrying one permission each. This applies to every permission supported
by this policy, not only to current examples.

Consequently:

- several applicable statements may cover one request;
- broad and narrow applicable constraints may contribute together;
- splitting or merging a permission map under equivalent constraints does not
  change Effective Permissions;
- statement order and exact duplicates do not change Effective Permissions;
- adding or broadening a positive statement can only preserve or expand the
  Requested Permissions the policy can cover;
  and
- the policy intentionally cannot permit permissions separately while
  forbidding their combination for the same subject token and resource.

Overlap is normal composition, not a separate error or security condition. The
compiler and tests do not maintain overlap identifiers, groups, inventories, or
pairwise satisfiability analysis.

Empty policy is valid and does not permit any request.

### Compilation and evaluation

Policy definitions are compiled once during application construction.
Compilation rejects malformed or unknown fields, validates local invariants,
copies and recursively freezes all owned data, and returns a structural Token
Issuance Policy snapshot containing the normalized Permit Statements.
It accepts duplicate and overlapping Permit Statements because pointwise union
is idempotent and overlap is intentional.

Evaluation is total for compiled policy and normalized inputs. One evaluator
returns exactly one discriminated outcome:

- `permitted`: applicable statements compose Effective Permissions that cover
  every Requested Permission;
- `target_unsupported`: no Repository Resource Constraint supports the exact
  Repository Resource;
- `requested_permissions_unsupported`: the Repository Resource is supported,
  but statements for that resource cannot compose coverage for every Requested
  Permission even before applying OIDC Subject Token Constraints; or
- `subject_token_unacceptable`: the Repository Resource and Requested
  Permissions are supported, but statements applicable to the Verified Subject
  Token do not cover every Requested Permission.

The evaluator derives both authorization and protocol classification in one
traversal. Callers do not first ask for a Boolean authorization result and then
repeat policy traversals with separate target- and permission-support queries.
Only `permitted` authorizes issuance. The other outcomes map to
`invalid_target`, `invalid_scope`, and `invalid_request`, respectively, at the
Token Endpoint. They do not expose matched statements, contributors, or
Claim-predicate detail. The snapshot's structure is part of the package
Interface; its current evaluation algorithm is not.

The compiled snapshot's `permitStatements[].resource` is a structural
Repository Resource Constraint:

- an exact constraint has `{ owner, repository }`;
- an owner-wide constraint has `{ owner, repository: null }`.

Policy consumers discriminate owner-wide constraints with
`resource.repository === null`.

No matched statement, stable statement identifier, contributor list, denial
detail, or independently callable support query is exposed.

### Trust Subject Token Claims

Successful OIDC validation authenticates the complete Subject Token Claims from one
exact configured issuer for the deployment's exact configured Subject-Token Audience.
That audience may be URL-shaped or opaque. It is distinct from the Token Exchange
Endpoint URL and from the RFC 8693 `audience` and `resource` parameters that describe
the requested output-token targets. Policy directly selects the Subject Token Claims
that are material to authorization; it does not reconstruct one signed representation
from another merely to check their consistency.

A reviewed application composition can select any signed GitHub Actions Claims
material to its authorization, such as `repository`, `event_name`, `ref_type`,
`ref`, or `workflow_ref`. Claims including `sub`, `repository_id`, and
`repository_owner_id` remain unconstrained unless the composition selects them
with Claim Predicates. GitHub supports replacing the complete default `sub`
format with a configured Claim template, so treating the default format as a
mandatory consistency checksum rejects legitimate tokens without adding
protection against payload tampering or issuer compromise.

The Fly provider capability uses no additional OIDC ID Token Profile. The
former checks that `org_name` matched the issuer organization slug and that
`sub` reconstructed from `org_name`, `app_name`, and `machine_name` are
removed. If a reviewed application composition configures a Fly registration
and Permit Statement, that statement directly selects whichever Subject Token
Claims are material to its authorization. Missing or differently typed selected
Claims make the statement not applicable rather than making an otherwise
validly signed token fail authentication.

GitHub Actions retains its Authorized Party check. Google retains `azp == sub`
as a token-kind discriminator separating the accepted service-account token
shape from Google user ID Tokens under the same Issuer Identifier.

### Authentication and authorization remain separate

OIDC Provider Registrations remain reviewed build-time authentication decisions.
Application composition verifies that every Issuer Identifier referenced by
policy has a configured Provider Registration. The reverse is not required:
registration alone creates no Permit Statement and grants no token-issuance
permission.

Policy refers to the exact Issuer Identifier carried by a Provider
Registration. Provider-specific policy matchers, inheritance, issuer aliases,
registration-derived capabilities, and automatic statement generation are not
introduced. Ordinary TypeScript constants, arrays, spreads, `map`, and
`flatMap` provide authoring reuse, including the capability to construct
parameterized Fly registrations and statements in a deployment composition.

### Scope

The generic OIDC Subject Token Constraint remains inside the specialized Token
Issuance Policy module. It is not extracted to a shared package until a second
real authorization consumer establishes a shared seam.

The design does not create a general principal/action/resource framework,
Boolean expression engine, role model, fragment system, policy inheritance
mechanism, callback registry, or service-specific base implementation.

## Consequences

- CEL and its direct dependencies, bindings, caches, helpers, and
  expression-specific tests are removed.
- Policy authoring exposes only operations required by reviewed policy.
- Weaker levels in the Requested Permissions are permitted by stronger
  configured levels.
- Permission names remain extensible; compiled Permit Statements must still
  cover every Requested Permission, and GitHub validates name and level
  compatibility after policy approval.
- Independently authored applicable statements contribute to the same Effective
  Permissions without changing the request sent to GitHub.
- The authorization model is deliberately closed under pointwise permission
  union.
- Configured GitHub Actions and Fly Permit Statements trust verified Subject
  Token Claims rather than imposing redundant cross-Claim consistency checks.
- Authorization and its Token Endpoint classification come from one total
  policy-evaluation result rather than repeated policy traversals.
- Operational logs retain the verified subject-token and normalized request
  context but contain only the policy outcome, not matched statements or
  contributor detail.
- Adding an OIDC Provider Registration does not authorize it; independent
  Permit Statements remain necessary.
- Recursive freezing prevents later mutation of policy authoring inputs from
  changing the compiled structural snapshot.

## Rejected alternatives

### Retain CEL with a documented subset

Rejected because the parser and evaluator would still accept and maintain a
substantially larger language than the domain requires. Documentation alone
would not make the implementation closed.

### General principal, action, and resource authorization engine

Rejected because there is one authorization operation, no normalized Principal
entity, and one Repository Resource type. Generalizing those dimensions would
weaken the current domain model without another consumer.

### Provider-specific implementations or inheritance

Rejected because provider identity does not own Repository Resources or
permissions. Typed Claim Predicates express required differences without base
classes, matcher registries, or provider-specific statement types.

### Registration-derived authorization

Rejected because accepting an issuer for authentication and permitting it to
receive an Installation Access Token are independent security decisions.

### Rule identifiers and denial-reason synthesis

Rejected because statements are not selected or referenced, and no single
generally correct cause exists when any combination of subject-token, resource,
and permission coverage can leave the request unpermitted.

### Require one statement to cover the complete request

Rejected because it assigns authorization meaning to definition-object
grouping and violates permission separability. A statement with two permissions
already permits either separately; splitting it into two applicable statements
must not revoke the combined request.

### Permission-composition identifiers, groups, or overlap analysis

Rejected because permission combination is the intended policy algebra. IDs,
groups, and overlap inventories would create non-domain coupling without
changing the permissions obtainable through separate permitted tokens.

### Cross-check redundant Subject Token Claims

Rejected because signature and issuer verification authenticate the provider's
complete payload. Cross-checking two provider-signed representations detects a
provider issuance inconsistency, but not client tampering, key compromise, or a
compromised issuer. It can also reject supported customized Claim formats.

## Residual risks

- Issuer-only OIDC Subject Token Constraints are intentionally valid and rely
  on careful review of the deployment's policy.
- Repository identity is name-based, so deleting and recreating a repository
  under the same owner and name can continue to match policy. GitHub App
  installation authority remains an independent control.
- TypeScript types do not validate runtime values. Compilation therefore
  defensively validates and freezes every policy definition.
- The ordered `read < write < admin` levels intentionally allow a configured
  stronger level to cover a weaker request.
- Permit-only composition is monotonic and cannot forbid a combined request
  when each Requested Permission is independently permitted for the same
  subject token and resource.
- Policy outcomes and logging do not attribute results to individual
  statements. A future attribution or inspection requirement needs a separate
  policy-version or inspection decision.

## References

- [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0-18.html)
- [OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693.html)
- [OAuth 2.0 Resource Indicators](https://www.rfc-editor.org/rfc/rfc8707.html)
- [OAuth 2.0 authorization grants](https://www.rfc-editor.org/rfc/rfc6749.html#section-1.3)
- [JSON Web Signature](https://www.rfc-editor.org/rfc/rfc7515.html)
- [GitHub Actions OIDC reference](https://docs.github.com/en/actions/reference/security/oidc)
- [GitHub installation access token API](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [Fly OpenID Connect](https://fly.io/docs/security/openid-connect/)
- [Cedar authorization](https://docs.cedarpolicy.com/auth/authorization.html)
- [AWS IAM policy evaluation](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html)
