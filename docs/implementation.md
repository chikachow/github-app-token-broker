# Implementation

## Workspace layout

- `packages/token-exchange`: runtime-neutral token exchange factory and Web request handler; owns composition snapshots, authentication, authorization, issuance, routing semantics, bounded bodies, caches, and sanitized observation events
- `packages/fastify`: encapsulated Fastify v5 `/token` adapter with scoped raw-body capture and explicit Web Response translation
- `workers/github-app-token-broker`: Cloudflare routing, environment, rate-limit, and logging adapter
- `packages/oidc`: exact-registration ID Token authentication, provider metadata/JWK Set retrieval, validation, caching, and diagnostics
- `packages/oidc-provider-fly`: source-supported exact Fly organization-scoped OIDC Provider Registration construction with an explicit null OIDC ID Token Profile
- `packages/oidc-provider-github-actions`: GitHub Actions OIDC Provider Registration and ID Token profile
- `packages/oidc-provider-google-service-account`: Google service-account OIDC Provider Registration and ID Token profile
- `packages/github`: Installation Access Token Request normalization, GitHub App JWT, repository installation resolution, owner binding, and installation-token minting
- `packages/token-issuance-policy`: structural Permit Statement compilation, validation, and evaluation
- `packages/http`: bounded body readers and HTTP/problem-response helpers
- `test`: behavioral tests, a real Workerd integration project, focused Fastify adapter tests, and a pnpm-deploy host fixture

There is no webhook runtime, deployment endpoint, dynamic issuer registry, App selector, or multi-key service.

## Worker composition

`createGitHubAppTokenExchange` accepts a `TokenExchangeComposition` containing OIDC Provider Registrations and one compiled `TokenIssuancePolicy`. It snapshots the registration array, rejects duplicate issuers, and requires every Permit Statement issuer to have a registration before returning the handler. It also receives semantic GitHub App configuration and the explicit subject-token audience. The returned interface is `(Request, { observe }) => Promise<Response>`; construction performs no network I/O.

Internally, the endpoint parses and validates the Web Request, calls an application function with a normalized command and explicit request diagnostics, and maps the application result to a Web Response. The application function captures the snapshotted GitHub App configuration, Token Issuance Policy, authenticator, and GitHub dependencies at construction. Web Request and Response objects do not enter authentication, authorization, or issuance code. These internal functions are implementation details rather than additional package interfaces for deployment adapters to compose.

An external deployment owns the TypeScript entrypoint that supplies those two values. The source package root has named exports only. `generic-worker.ts` is the public-safe Wrangler entrypoint and deliberately composes empty registrations with an empty, deny-all Token Issuance Policy. A built artifact cannot replace its composition through bindings or requests.

Optional runtime dependencies are a construction and test seam for Fetch and time. They are not a trust or authorization configuration surface. Observation is per request so Fastify can use `request.log` and `request.id`; the core has no console dependency.

The Worker deployment supplies one non-secret `TOKEN_BROKER_AUDIENCE` binding. On the first request, before Worker routing completes, `worker.ts` constructs the runtime-neutral handler and its factory validates that value as an exact non-empty, non-whitespace, single-line scalar; the adapter rejects an audience change within an isolate. A Fastify host passes the same semantic value directly as `subjectTokenAudience` during application composition. Neither adapter owns a public endpoint-location binding or derives the audience from the incoming request URL, headers, or source-owned `/token` route.

Source GitHub Actions workflows use a pinned external action as their transport seam, relying on its caller-side Repository Resource and least-privilege Requested Permissions defaults where appropriate and explicitly overriding them when needed. The workflow files are authoritative for that caller-side contract; the broker does not own a permission default.

App credentials remain Worker environment bindings. One Worker instance receives one App ID/private key pair. The request surface never selects an App.

## Request flow

1. The Worker adapter rejects every path except `/token` and applies its Cloudflare limiter to POST requests before the core. The Fastify adapter registers all ordinary methods at `/token`, applies a scoped raw parser, and relies on host-owned admission control.
2. The runtime-neutral endpoint parses the request by rejecting non-POST methods and enforcing OAuth media type, bounded body size, form multiplicity, unsupported fields, and RFC 8693 identifiers; `installation-access-token-request.ts` requires explicit resource and scope values and normalizes their canonical domain forms without permission defaults.
3. The endpoint calls the application function with only the serialized subject token, normalized Installation Access Token Request, observation function, path, and user agent.
4. `authentication.ts` passes the serialized ID Token to the deep OIDC authenticator and exposes only verified claims/evidence.
5. `packages/token-issuance-policy` evaluates immutable, independently complete Permit Statements and composes covered permissions pointwise.
6. `installation-access-token-issuance.ts` classifies authorization before any GitHub request.
7. `packages/github` signs a short-lived App JWT, resolves the requested repository installation, validates the returned installation owner against the requested owner, and mints a token limited to the repository and requested permissions.
8. The endpoint maps the application result to stable OAuth errors or a success response and returns non-cacheable responses without logging raw tokens.

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
fnm exec --using=24 corepack pnpm run build
fnm exec --using=24 corepack pnpm run deploy:smoke
```

The root Wrangler file is a unit-test harness. It intentionally repeats the package Worker's compatibility flags and binding shapes so Workerd unit tests execute under the production runtime constraints; `env-types:check`, the Worker integration project, and the package dry-run validate the deployable config. The package Wrangler file is a public-safe dry-run template; deployment-owned identifiers and routes are supplied by the external deployment system.
