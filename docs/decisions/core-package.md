# One runtime-neutral core package

Decision status: Accepted.

The broker's runtime-neutral modules are distributed as
`@github-app-token-broker/core`. The Worker and Fastify adapters remain separate
packages because they have distinct host dependencies and lifecycle obligations.
OIDC authentication, Token Issuance Policy, GitHub issuance, and HTTP handling
remain cohesive internal modules. Explicit provider exports supply reviewed
OIDC Provider Registrations without registering trust or authorizing issuance.

The existing private workspace packages were consumed together through one
pinned source revision. Consolidation removes eight package manifests, build
configurations, and workspace dependency relationships without merging those
security responsibilities. Core uses relative imports internally and emits ESM
and declarations once. Deliberate package subpaths preserve deployment composition
and host-adapter consumers; tests may still inspect private built modules.

Retaining separate packages would be appropriate for independently released
libraries, but no such release requirement was demonstrated. Moving both host
adapters into core would couple runtime-neutral consumers to host dependencies.

## Consumer migration

Replace each runtime-neutral workspace dependency with
`@github-app-token-broker/core` and update imports as follows. Worker and Fastify
package identities remain unchanged.

| Previous import                                     | Replacement import                                    |
| --------------------------------------------------- | ----------------------------------------------------- |
| `@github-app-token-broker/token-exchange`           | `@github-app-token-broker/core`                       |
| `@github-app-token-broker/token-issuance-policy`    | `@github-app-token-broker/core/token-issuance-policy` |
| `@github-app-token-broker/github/<module>`          | `@github-app-token-broker/core/github/<module>`       |
| `@github-app-token-broker/oidc/<module>`            | `@github-app-token-broker/core/oidc/<module>`         |
| `@github-app-token-broker/http/<module>`            | `@github-app-token-broker/core/http/<module>`         |
| `@github-app-token-broker/oidc-provider-<provider>` | `@github-app-token-broker/core/providers/<provider>`  |

The provider names remain `buildkite`, `fly`, `github-actions`, and
`google-service-account`. The package manifest lists each supported subpath;
there are no wildcard exports or compatibility packages under the old names.

Regenerate the consumer lockfile, build the selected source revision, and verify
the consumer's package imports, declarations, reviewed composition, and deployment
artifact together. Preserve its independent policy expectations and exact source
acceptance checks. A locally tested candidate does not establish an accepted
source revision or authorize a production source-pin update. The
[deployment guide](../deployment.md) owns those publication obligations.
