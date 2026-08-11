# Implementation

## Workspace layout

- `workers/github-app-token-broker`: the only runtime, package `@github-app-token-broker/worker`, and the only public route (`POST /token`)
- `packages/oidc`: exact-registration ID Token authentication, provider metadata/JWK Set retrieval, validation, caching, and diagnostics
- `packages/oidc-provider-fly`: source-supported exact Fly organization-scoped OIDC Provider Registration construction with an explicit null OIDC ID Token Profile
- `packages/oidc-provider-github-actions`: GitHub Actions ID Token profile
- `packages/oidc-provider-google-service-account`: Google service-account ID Token profile
- `packages/github`: GitHub App JWT, repository installation resolution, owner binding, and installation-token minting
- `packages/http`: bounded body readers and HTTP/problem-response helpers
- `test`: behavioral unit tests plus a real Workerd integration project for the Worker entrypoint

There is no webhook runtime, deployment endpoint, dynamic issuer registry, App selector, or multi-key service.

## Deployment composition

`configured-token-exchange-composition.ts` is the intentionally small checked-in source/build composition seam. It exports an immutable object containing `oidcProviderRegistrations` and `tokenIssuancePolicy`. `dependencies.ts` combines that composition with runtime dependencies (`fetch` and clock) and asserts that every policy issuer is registered before constructing the exchange. The build therefore compiles the selected registrations and policy into the Worker artifact. Deployments of the same already-compiled artifact cannot replace them through bindings or other runtime configuration; a different registration or policy set may reuse the runtime implementation but requires a different reviewed source composition and rebuild. The dependency-injection interface supports construction and tests, not runtime deployment configuration.

The deployment supplies one non-secret `TOKEN_BROKER_AUDIENCE` Worker binding. Before routing any request, the Worker-local `parseSubjectTokenAudience` function validates it as an exact non-empty, non-whitespace, single-line scalar. `worker.ts` constructs and caches the exchange with that explicit audience and rejects an audience change within an isolate. It owns no public endpoint-location binding and does not derive the audience from the incoming request URL, headers, or source-owned `/token` route. The OIDC ID Token Authenticator accepts this composed audience rather than embedding a project name, preserving reuse and exact scalar-audience validation.

Source GitHub Actions workflows use a separate, immutable release of `chikachow/cyspbot-app-token-action` as their transport seam. The action always requests GitHub OIDC for `https://cyspbot.chikachow.org`; its default Token Exchange Endpoint URL is that audience plus `/token`, and an optional explicit URL changes only the request destination. It validates a canonical credential-free HTTPS URL, rejects redirects, and requires the returned scope to match the requested scope. The selected endpoint receives the ID Token subject token and can observe an Installation Access Token when it proxies the request; the authority controlling the URL is already trusted to obtain and handle those credentials. The source workflows always pass explicit resources and least-privilege scopes, so the action's convenience scope default is not a broker default.

App credentials remain Worker environment bindings. One Worker instance receives one App ID/private key pair. The request surface never selects an App.

## Request flow

1. `worker.ts` rejects every path except `/token` and every method except `POST`, then applies the deployment rate limit.
2. `token-exchange.ts` enforces OAuth media type, bounded body size, form multiplicity, unsupported fields, and RFC 8693 identifiers; `installation-access-token-request.ts` requires explicit resource and scope values and normalizes their canonical domain forms without permission defaults.
3. `authentication.ts` passes the serialized ID Token to the deep OIDC authenticator and exposes only verified claims/evidence.
4. `token-issuance-policy.ts` evaluates immutable, independently complete Permit Statements and composes covered permissions pointwise.
5. `installation-access-token-issuance.ts` classifies authorization before any GitHub request.
6. `packages/github` signs a short-lived App JWT, resolves the requested repository installation, validates the returned installation owner against the requested owner, and mints a token limited to the repository and requested permissions.
7. The endpoint maps failures to stable OAuth errors and returns non-cacheable success/error responses without logging raw tokens.

## OIDC security boundary

The authenticator derives the issuer only to select an exact preconfigured registration. It validates discovery issuer equality, permitted algorithms, JWK Set response shape and keys, signature, required claims, time claims, exact scalar audience, optional provider profile, and bounded stale-cache rules. A provider registration authenticates tokens but never creates policy authorization.

The source supports constructing a Fly registration for one canonical organization slug and the exact issuer `https://oidc.fly.io/{organization-slug}`. That registration accepts only RS256 and has an explicit null OIDC ID Token Profile, so central ID Token validation authenticates its signed Machine identity Claims without imposing relationships among Fly contextual Claims. A custom reviewed source composition and build must register the exact organization issuer and independently add Permit Statements selecting every material Claim. Fly documents [the issuer and Machine identity Claim model](https://fly.io/docs/security/openid-connect/) and [Machine token acquisition with an explicit audience](https://fly.io/docs/machines/api/tokens-resource/).

The default production composition registers exactly GitHub Actions and Google service-account profiles. It does not register Fly and contains no Fly Permit Statement. Only issuers referenced by checked-in Permit Statements can authorize issuance.

The authoritative configured provider and 16-statement policy inventories are maintained in the [service contract](service-contract.md#configured-production-oidc-provider-registrations). Keeping that inventory in one place prevents documentation drift; this implementation reference describes how the compiled composition enforces it.

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

The root Wrangler file is a unit-test harness. It intentionally repeats the package Worker's compatibility flags and binding shapes so Workerd unit tests execute under the production runtime constraints; `env-types:check`, the Worker integration project, and the package dry-run validate the deployable config. The package Wrangler file is a public-safe dry-run template; deployment-owned identifiers and routes belong in the private deployment repository.
