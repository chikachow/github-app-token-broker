# Implementation

## Workspace layout

- `workers/github-app-token-broker`: the only runtime, package `@github-app-token-broker/worker`, and the only public route (`POST /token`)
- `packages/oidc`: exact-registration ID Token authentication, provider metadata/JWK Set retrieval, validation, caching, and diagnostics
- `packages/oidc-provider-fly`: source-supported exact Fly organization-scoped OIDC Provider Registration construction with an explicit null OIDC ID Token Profile
- `packages/oidc-provider-github-actions`: GitHub Actions OIDC Provider Registration and ID Token profile
- `packages/oidc-provider-google-service-account`: Google service-account OIDC Provider Registration and ID Token profile
- `packages/github`: Installation Access Token Request normalization, GitHub App JWT, repository installation resolution, owner binding, and installation-token minting
- `packages/token-issuance-policy`: structural Permit Statement compilation, validation, and evaluation
- `packages/http`: bounded body readers and HTTP/problem-response helpers
- `test`: behavioral unit tests plus a real Workerd integration project for the Worker entrypoint

There is no webhook runtime, deployment endpoint, dynamic issuer registry, App selector, or multi-key service.

## Worker composition

`createTokenExchangeWorker` accepts a `TokenExchangeComposition` containing OIDC Provider Registrations and one compiled `TokenIssuancePolicy`. It snapshots the registration array, rejects duplicate issuers, and requires every Permit Statement issuer to have a registration before returning the Worker handler. The policy compiler validates and recursively freezes its structural result, so composition needs no opaque identity map or module-owned state. Construction performs no network I/O.

An external deployment owns the TypeScript entrypoint that supplies those two values. The source package root has named exports only. `generic-worker.ts` is the public-safe Wrangler entrypoint and deliberately composes empty registrations with an empty, deny-all Token Issuance Policy. A built artifact cannot replace its composition through bindings or requests.

The optional `TokenExchangeWorkerRuntimeDependencies` parameter is a construction and test seam for Fetch and time. The default adapters late-bind the runtime Fetch implementation and clock. It is not a trust or authorization configuration surface.

The deployment supplies one non-secret `TOKEN_BROKER_AUDIENCE` Worker binding. Before routing any request, the Worker-local `parseSubjectTokenAudience` function validates it as an exact non-empty, non-whitespace, single-line scalar. `worker.ts` constructs and caches the exchange with that explicit audience and rejects an audience change within an isolate. It owns no public endpoint-location binding and does not derive the audience from the incoming request URL, headers, or source-owned `/token` route. The OIDC ID Token Authenticator accepts this composed audience rather than embedding a project name, preserving reuse and exact scalar-audience validation.

Source GitHub Actions workflows use a pinned external action as their transport seam, relying on its caller-side Repository Resource and least-privilege Requested Permissions defaults where appropriate and explicitly overriding them when needed. The workflow files are authoritative for that caller-side contract; the broker does not own a permission default.

App credentials remain Worker environment bindings. One Worker instance receives one App ID/private key pair. The request surface never selects an App.

## Request flow

1. `worker.ts` rejects every path except `/token` and every method except `POST`, then applies the deployment rate limit.
2. `token-exchange.ts` enforces OAuth media type, bounded body size, form multiplicity, unsupported fields, and RFC 8693 identifiers; `installation-access-token-request.ts` requires explicit resource and scope values and normalizes their canonical domain forms without permission defaults.
3. `authentication.ts` passes the serialized ID Token to the deep OIDC authenticator and exposes only verified claims/evidence.
4. `packages/token-issuance-policy` evaluates immutable, independently complete Permit Statements and composes covered permissions pointwise.
5. `installation-access-token-issuance.ts` classifies authorization before any GitHub request.
6. `packages/github` signs a short-lived App JWT, resolves the requested repository installation, validates the returned installation owner against the requested owner, and mints a token limited to the repository and requested permissions.
7. The endpoint maps failures to stable OAuth errors and returns non-cacheable success/error responses without logging raw tokens.

## OIDC security boundary

The authenticator derives the issuer only to select an exact preconfigured registration. It validates discovery issuer equality, permitted algorithms, JWK Set response shape and keys, signature, required claims, time claims, exact scalar audience, optional provider profile, and bounded stale-cache rules. A provider registration authenticates tokens but never creates policy authorization.

The source supports constructing a Fly registration for one canonical organization slug and the exact issuer `https://oidc.fly.io/{organization-slug}`. That registration accepts only RS256 and has an explicit null OIDC ID Token Profile, so central ID Token validation authenticates its signed Machine identity Claims without imposing relationships among Fly contextual Claims. A deployment selecting it must register the exact organization issuer and independently add Permit Statements selecting every material Claim. Fly documents [the issuer and Machine identity Claim model](https://fly.io/docs/security/openid-connect/) and [Machine token acquisition with an explicit audience](https://fly.io/docs/machines/api/tokens-resource/).

Provider packages similarly export reviewed GitHub Actions and Google service-account registrations. Package availability is capability, not configured trust or authorization. Each deployment's entrypoint and tests are authoritative for the inventory compiled into its artifact.

## GitHub security boundary

Successful GitHub responses are bounded and schema-validated. Installation resolution follows GitHub redirects only through the platform fetch boundary and then requires case-insensitive equality between the requested repository owner and the returned installation `account.login`. A mismatch stops before token minting. GitHub transport, rate-limit, upstream, and configuration failures remain separately classified.

Detailed OpenID Provider Metadata and JWK Set cache limits, refresh behavior, stale fallback, and error mappings remain authoritative in the [service contract](service-contract.md) and [OIDC authentication decision](decisions/oidc-id-token-authentication.md); the extraction does not change them.

## Validation

Use Node 24 and pinned pnpm:

```bash
fnm exec --using=24 corepack pnpm run format:check
fnm exec --using=24 corepack pnpm run lint
fnm exec --using=24 corepack pnpm run typecheck
fnm exec --using=24 corepack pnpm run knip
fnm exec --using=24 corepack pnpm run test
fnm exec --using=24 corepack pnpm run test:coverage
fnm exec --using=24 corepack pnpm run env-types:check
fnm exec --using=24 corepack pnpm run deploy:dry-run
```

The root Wrangler file is a unit-test harness. It intentionally repeats the package Worker's compatibility flags and binding shapes so Workerd unit tests execute under the production runtime constraints; `env-types:check`, the Worker integration project, and the package dry-run validate the deployable config. The package Wrangler file is a public-safe dry-run template; deployment-owned identifiers and routes are supplied by the external deployment system.
