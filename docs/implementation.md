# Implementation

## Workspace layout

- `workers/github-app-token-broker`: the Cloudflare adapter, package `@github-app-token-broker/worker`, and the only deployed public route (`POST /token`)
- `packages/oidc`: exact-registration ID Token authentication, provider metadata/JWK Set retrieval, validation, caching, and diagnostics
- `packages/oidc-provider-fly`: source-supported exact Fly organization-scoped OIDC Provider Registration construction with an explicit null OIDC ID Token Profile
- `packages/oidc-provider-github-actions`: GitHub Actions OIDC Provider Registration and ID Token profile
- `packages/oidc-provider-google-service-account`: Google service-account OIDC Provider Registration and ID Token profile
- `packages/github`: Installation Access Token Request normalization, the Repository Resource-oriented issuance capability, GitHub App JWT authentication, owner binding, installation-token minting, and GitHub App Information queries
- `packages/token-issuance-policy`: structural Permit Statement compilation, validation, and evaluation
- `packages/http`: bounded body readers and HTTP/problem-response helpers
- `packages/token-exchange`: the runtime-neutral deep module behind the Token Endpoint, including protocol validation, authentication orchestration, policy-controlled issuance, observations, and OAuth response mapping
- `packages/fastify`: the Node 24/Fastify 5 adapter for mounting a prebuilt runtime-neutral handler
- `test`: behavioral unit tests for the Token Endpoint, Fastify adapter, and domain packages; a production-deployed Fastify consumer fixture; and a real Workerd integration project for the GitHub App Information RPC entrypoint

There is no webhook runtime, deployment endpoint, dynamic issuer registry, App selector, or multi-key service.

## GitHub App Information RPC

`packages/github/src/app-information.ts` is the runtime-neutral read-only
module behind the Worker's named `GitHubAppInformationEntrypoint`. The
Cloudflare entrypoint remains a thin adapter around that module: it maps the
`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` bindings to semantic `{ appId,
privateKey }` configuration before crossing the runtime-neutral seam. It uses
the same configured App JWT machinery as token issuance but never creates an
Installation Access Token. Its four methods map directly to GitHub's App-JWT
metadata endpoints and return GitHub-shaped values. The entrypoint is exported
from `generic-worker.ts` for an explicitly configured Cloudflare service
binding; no HTTP route is added.

Every GitHub request uses the fixed `https://api.github.com` destination and a
broker-owned 10-second deadline covering headers and the complete bounded body.
The module validates positive installation IDs, bounded pagination, and
single-segment repository inputs; accepts GitHub's user, enterprise, and
nullable installation-account response variants; passes through additive
GitHub response fields; and converts downstream and internal failures to stable
RPC error names. The installation-list page uses a separate 1 MiB bound while
the existing 64 KiB GitHub response default remains in place for smaller
documents. The
[GitHub App Information RPC decision](decisions/github-app-information-rpc.md)
records the design rationale, the
[research note](research/github-app-information.md) records the endpoint
evidence, and the [service contract](service-contract.md) is authoritative for
the implemented capability and security boundary.

## Token Exchange composition

`createGitHubAppTokenExchange` accepts a `TokenExchangeComposition` containing OIDC Provider Registrations and one compiled `TokenIssuancePolicy`, semantic `{ appId, privateKey }` GitHub App credentials, and the exact Subject-Token Audience. It snapshots the registration array and credentials, rejects duplicate issuers, and requires every Permit Statement issuer to have a registration before returning its Fetch-compatible handler. The GitHub API destination is not part of this interface and remains fixed inside `packages/github`. The policy compiler validates and recursively freezes its structural result, so composition needs no opaque identity map or module-owned state. Construction performs no network I/O.

`createTokenExchangeWorker` is a Cloudflare adapter around that handler. It preserves construction-time composition validation, translates Worker credential and audience bindings to the semantic interface, owns path routing and rate limiting before the handler, and recreates the configured handler if App credentials change. Rate limiting is deliberately not a token-exchange configuration knob because admission policy and request identity belong to the hosting adapter.

`githubAppTokenExchangePlugin` is an encapsulated Fastify adapter around an already-built handler.
It registers the `/token` path broadly and normalizes routed non-`POST` methods to the OAuth
`invalid_request` response before Fetch request construction because Fetch cannot represent every
Node method. Node can reject `TRACK` and `CONNECT` before Fastify plugin routing, so those transport
failures have no adapter OAuth-shape promise. The plugin removes inherited parsers only in its child
scope, installs one raw Buffer form parser, and applies the public Token Exchange body limit at the
route. The adapter converts documented Fastify parser failures and malformed Fastify-to-Fetch
request metadata to the exported OAuth `invalid_request` response. Unrecognized handler and
Fastify errors propagate to the host. It reconstructs duplicate request headers from Node raw
headers, copies Fetch response metadata and bytes into the Fastify reply, and preserves separate
`Set-Cookie` fields.

The Fastify request logger receives mandatory and optional observations at their declared levels.
Mandatory logging is Promise-based and a synchronous logger failure propagates to the deep
handler; optional diagnostic logger failures are contained. The plugin does not configure
credentials, admission, listener lifecycle, or proxy trust. It does not emulate client-disconnect
cancellation: early Fastify 5 versions have no uniform request signal, and the current deep
handler's outbound operations use their own broker-owned deadlines rather than its input Request
signal.

The compiled policy snapshot is a public structural Interface. Its
`permitStatements[].resource` is a Repository Resource Constraint with an
`owner` and either a string `repository` or `repository: null`. Policy
consumers discriminate owner-wide constraints with `repository === null`.

An external deployment owns the TypeScript entrypoint that supplies those two values. The source package root has named exports only. `generic-worker.ts` is the public-safe Wrangler entrypoint and deliberately composes empty registrations with an empty, deny-all Token Issuance Policy. A built artifact cannot replace its composition through bindings or requests.

The runtime-neutral handler accepts a request context with mandatory `observe` and separately named optional `observeOidcDiagnostic` callbacks. `observe` returns `Promise<void>` and is awaited; fulfillment acknowledges the observation but does not itself prove durable persistence. `observeOidcDiagnostic` is synchronous and returns exactly `undefined`. It is never wired to the mandatory observer, and diagnostic callback failures are contained. The Worker adapter supplies these callbacks from `TokenExchangeWorkerRuntimeDependencies`; its request-scoped mandatory-observer wrapper enriches fields with the Cloudflare Ray ID and returns the underlying observer promise so failures remain fail closed. The runtime-neutral module does not inspect Cloudflare headers. The default adapters write both event classes to the console. Fetch and time remain construction/test seams. These dependencies are not trust or authorization configuration surfaces, although mandatory observation availability deliberately controls whether the endpoint can return a token.

The deployment supplies one non-secret `TOKEN_BROKER_AUDIENCE` Worker binding. Before routing any request, the OIDC package's single Subject-Token Audience parser validates it as an exact non-empty, non-whitespace, single-line domain value. `worker.ts` constructs and caches the exchange with that explicit audience and rejects an audience change within an isolate. It owns no public endpoint-location binding and does not derive the audience from the incoming request URL, headers, or source-owned `/token` route. The OIDC ID Token Authenticator accepts this composed domain value rather than embedding a project name, preserving reuse and exact scalar-audience validation.

Source GitHub Actions workflows use a pinned external action as their transport seam, relying on its caller-side Repository Resource and least-privilege Requested Permissions defaults where appropriate and explicitly overriding them when needed. The workflow files are authoritative for that caller-side contract; the broker does not own a permission default.

App credentials remain Worker environment bindings. One Worker instance receives one App ID/private key pair. The request surface never selects an App.

## Cloudflare Worker request flow

1. `worker.ts` rejects every path except `/token` and every method except `POST`; the Token Endpoint applies the deployment rate limit with `CF-Connecting-IP` as its only request-derived key and uses `unknown` when that header is absent.
2. `token-exchange.ts` enforces OAuth media type, bounded body size, form multiplicity, unsupported fields, and RFC 8693 identifiers; `installation-access-token-request.ts` requires explicit resource and scope values and normalizes their canonical domain forms without permission defaults.
3. `authentication.ts` passes the serialized ID Token to the deep OIDC authenticator and exposes only the immutable verified Claims snapshot and verification evidence.
4. `packages/token-issuance-policy` evaluates immutable, independently complete Permit Statements once and returns one of `permitted`, `target_unsupported`, `requested_permissions_unsupported`, or `subject_token_unacceptable`.
5. `installation-access-token-issuance.ts` maps that single evaluation result and awaits a token-free `installation_access_token_issuance_started` observation before any GitHub request.
6. `packages/github` accepts the normalized Repository Resource and Requested Permissions at one issuance boundary, resolves App authentication once for the exchange, resolves the requested repository installation, validates the returned installation owner, and mints a token limited to the repository and Requested Permissions.
7. The issuance module awaits `installation_access_token_issuance_succeeded` before returning a token. Rejection triggers one awaited best-effort revocation with the minted token and never re-enters the failed observer.
8. The Token Endpoint maps known failures to stable OAuth errors and sanitizes every otherwise unexpected failure to non-cacheable `500 {"error":"server_error"}` without logging raw tokens.

## OIDC security boundary

The authenticator derives the issuer only to select an exact preconfigured registration. One operation captures one injected time value and supplies it to JOSE and cache decisions. The authenticator validates discovery issuer equality, permitted algorithms, strict structure for every consumed JWK member, signature, required Claims, time Claims, the exact Subject-Token Audience, optional provider profile, and bounded stale-cache rules. It copies and recursively freezes verified JSON Claims before a provider profile or policy can inspect them. A provider registration authenticates tokens but never creates policy authorization.

The source supports constructing a Fly registration for one canonical organization slug and the exact issuer `https://oidc.fly.io/{organization-slug}`. That registration accepts only RS256 and has an explicit null OIDC ID Token Profile, so central ID Token validation authenticates its signed Machine identity Claims without imposing relationships among Fly contextual Claims. A deployment selecting it must register the exact organization issuer and independently add Permit Statements selecting every material Claim. Fly documents [the issuer and Machine identity Claim model](https://fly.io/docs/security/openid-connect/) and [Machine token acquisition with an explicit audience](https://fly.io/docs/machines/api/tokens-resource/).

Provider packages similarly export reviewed GitHub Actions and Google service-account registrations. Package availability is capability, not configured trust or authorization. Each deployment's entrypoint and tests are authoritative for the inventory compiled into its artifact.

## GitHub security boundary

Successful GitHub responses are bounded and schema-validated. The GitHub API destination is fixed to `https://api.github.com`; redirect responses are rejected before any follow-up request, and each request has a fixed 10-second deadline spanning response headers and complete bounded body consumption. Installation resolution also requires case-insensitive equality between the requested repository owner and the returned installation `account.login`. A mismatch stops before token minting. Once resolution succeeds, the deep issuance capability retains the installation ID for operational context even when the subsequent mint request fails. The broker sends no temporary stateful-token override and treats returned Installation Access Token values as opaque, accepting both legacy opaque and JWT-shaped installation-token formats. If mandatory success observation fails, the GitHub HTTP adapter uses the token itself for one fixed-origin, redirect-rejecting, deadline-bounded `DELETE /installation/token` revocation request. GitHub transport, rate-limit, upstream, and configuration failures remain separately classified, and logs distinguish the broker's synthetic classification from an actual upstream HTTP status.

Detailed OpenID Provider Metadata and JWK Set cache limits, refresh behavior, stale fallback, and error mappings remain authoritative in the [service contract](service-contract.md) and [OIDC authentication decision](decisions/oidc-id-token-authentication.md); the extraction does not change them.

## Validation

Use Node 24 and pinned pnpm:

```bash
fnm exec --using=24 corepack pnpm run check
fnm exec --using=24 corepack pnpm run test:coverage
fnm exec --using=24 corepack pnpm run test:mutations:property
```

The aggregate check builds once, then reuses that artifact for the artifact, typecheck, test, Node production-consumer, and deployment lanes. Standalone `artifact:check`, `typecheck`, `test`, `node-deploy:check`, and `deploy:dry-run` commands build their prerequisites first. Workspace builds synchronize injected package copies, so those standalone commands also work after a frozen clean install with no pre-existing `dist`. The artifact check imports the built Token Exchange ESM directly under Node and typechecks a self-importing consumer through the package's exports and bundled declarations; no source alias participates. The Node deployment check production-deploys a Fastify host fixture, imports the deployed package roots, typechecks the public adapter options, and exercises a real loopback listener. The root Wrangler file is a unit-test harness. It intentionally repeats the package Worker's compatibility flags and binding shapes so Workerd unit tests execute under the production runtime constraints; `env-types:check`, the GitHub App Information Workerd integration project, and the package dry-run validate the deployable config. The package Wrangler file is a public-safe dry-run template; deployment-owned identifiers and routes are supplied by the external deployment system.
