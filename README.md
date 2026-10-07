# github-app-token-broker

`github-app-token-broker` is a narrowly scoped Security Token Service for trusted automation workloads. It authenticates OpenID Connect ID Tokens from configured issuers and performs Installation Access Token Issuance only when Token Issuance Policy permits the resulting Verified Subject Token and Installation Access Token Request.

The only public service route is `POST /github/apps/{app_slug}/token`. The route selects one configured GitHub App; it does not grant authority. The service has no webhook receiver, deployment trigger endpoint, or client-controlled issuer configuration.

## Architecture

- `workers/github-app-token-broker` is the sole deployable Cloudflare Worker package (`@github-app-token-broker/worker`).
- `packages/oidc` owns the deep ID Token authenticator, OIDC Provider Registration validation, discovery/JWK Set validation, bounded caches, and fail-closed error classification.
- `packages/github` owns Installation Access Token Request normalization, the Repository Resource-oriented issuance capability, GitHub App JWT authentication, owner binding, installation-token minting, and GitHub App Information queries.
- `packages/token-exchange` owns the runtime-neutral Token Exchange handler that composes request validation, OIDC authentication, Token Issuance Policy, GitHub issuance, mandatory observations, and OAuth responses behind one Fetch-compatible interface.
- `packages/fastify` is a Node 24/Fastify 5 adapter around a prebuilt Token Exchange handler. It owns only the encapsulated `/github/apps/{app_slug}/token` route, raw form parsing, Fetch request/response translation, and request-scoped observation logging.
- `packages/token-issuance-policy` owns Permit Statement compilation and evaluation.
- `packages/http` owns bounded request/response body helpers and problem responses.
- Provider packages contain reviewed GitHub Actions, Google service-account, and Buildkite registrations plus exact organization-scoped Fly OIDC Provider Registration construction.
- `createGitHubAppTokenExchange` accepts a GitHub App catalogue with explicit audiences and credentials, OIDC Provider Registrations, and an app-qualified compiled Token Issuance Policy. `createTokenExchangeWorker` is the Cloudflare adapter that supplies bindings, admission control, and observation adapters. The Fastify plugin accepts only the already-built handler; its host owns credentials, admission, lifecycle, proxy trust, and listening. An external deployment owns the TypeScript composition and compiles it into its artifact. The source Wrangler template instead uses a generic deny-all entrypoint.

A deployment can serve multiple explicitly configured GitHub Apps. App slugs, client IDs, accepted Subject-Token Audiences, OIDC Provider Registrations, and Token Issuance Policy are reviewed build-time composition. Private keys remain runtime secrets. Every Permit Statement names its GitHub App client ID, and no permissions combine across apps. Adding or changing trust requires a reviewed composition change and a newly built artifact. See the [multi-app decision](docs/decisions/multiple-github-apps.md).

## `POST /github/apps/{app_slug}/token`

The endpoint implements the repository's RFC 8693 profile using `application/x-www-form-urlencoded` requests:

```http
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
requested_token_type=urn:ietf:params:oauth:token-type:access_token
resource=https://api.github.com/repos/{owner}/{repo}
subject_token=<openid-connect-id-token>
subject_token_type=urn:ietf:params:oauth:token-type:id_token
scope=contents:read
```

The standards-defined access-token identifier is canonical for new Clients. The
deprecated `urn:chikachow:github-app-installation-access-token` request value
remains accepted for compatibility with pinned action releases; the response
echoes whichever supported identifier the Client requested in
`issued_token_type`.

Important invariants:

- issuer trust comes only from exact OIDC Provider Registrations compiled into the reviewed deployment artifact
- the ID Token must have one scalar `aud` exactly matching an audience configured for the selected app; the RFC 8693 `audience` parameter is unsupported and grants nothing
- verified Claims are copied into an immutable snapshot before a provider profile or Token Issuance Policy can inspect them; profile admission and policy authorization remain separate decisions
- every request names exactly one canonical Repository Resource
- every request explicitly names a non-empty `scope`; the broker has no default Requested Permissions
- Subject Token Claims never select the target repository
- authentication never grants authorization; independently complete Permit Statements for the selected app must cover the requested resource and every permission
- installation lookup must return an installation whose `account.login` matches the requested owner, case-insensitively, before minting
- the configured GitHub App installation remains the upper bound on repositories and permissions
- GitHub requests use only `https://api.github.com` and have a broker-owned 10-second deadline covering response headers and the complete bounded body
- no Installation Access Token is returned until mandatory pre-mint intent and post-mint success observations are acknowledged; failed post-mint acknowledgement triggers awaited best-effort fixed-origin revocation
- every Token Endpoint success and error response is non-cacheable; an unexpected failure is sanitized to `500 {"error":"server_error"}`, and raw subject/access tokens are not logged

See [the service contract](docs/service-contract.md) for complete request, response, error, provider, and policy behavior; [implementation](docs/implementation.md) for code boundaries; and [deployment](docs/deployment.md) for the public-source/external-deployment interface.

## Cloudflare Worker configuration

The deployment supplies `githubApps` to `createTokenExchangeWorker`. Each record contains `slug`, `clientId`, a non-empty `subjectTokenAudiences` array, and `privateKeyBinding`, naming that app's Worker secret or Secrets Store binding. The Worker also requires `TOKEN_EXCHANGE_RATE_LIMIT`. See the [migration checklist](docs/release.md#multi-app-migration) when upgrading a singleton deployment.

Audience values are exact non-empty, non-whitespace, single-line strings. They are never inferred from a request URL, `Host`, or forwarded headers. A deployment may explicitly configure both a common broker audience and app-specific vanity audiences. Array-valued token audiences remain unsupported. OIDC discovery and JWK Set caches are shared per issuer, while authentication and authorization remain bound to the selected app.

`createGitHubAppInformationEntrypoint(githubApps)` constructs the named RPC export. Each trusted consumer binding must set `props.githubAppClientId` to one configured app. A consumer can use multiple bindings with different selectors; RPC methods cannot change that selection.

## Local development

Use Node 24 and the pinned pnpm version:

```bash
fnm exec --using=24 corepack pnpm install --frozen-lockfile
fnm exec --using=24 corepack pnpm run check
```

The source Worker has an empty app catalogue and returns `404` for every HTTP route. It needs no App credentials. The development command expects a `.dev.vars` file; create an empty one if needed and run the generic template:

```bash
touch .dev.vars
fnm exec --using=24 corepack pnpm run dev
```

Use an external deployment-owned entrypoint to configure app identities, audiences, policy, and matching private-key binding names for real exchanges. The [container suite](test/integration/README.md) provides a complete synthetic deployment. `.dev.vars.example` illustrates an optional key binding for a custom local composition.

Do not commit keys, `.dev.vars`, `.env`, `.wrangler/`, `.local-secrets/`, or private deployment overlays.

## Deployment boundaries

This public repository does not deploy the service. A deployment system outside
this repository must pin a reviewed source revision, run the source checks,
supply deployment-owned configuration and secrets, deploy the selected host,
and verify `POST /github/apps/{app_slug}/token`. A Cloudflare deployment also constructs and tests
`GitHubAppInformationEntrypoint` when providing the internal service-binding RPC;
a Node deployment composes the runtime-neutral handler into its Fastify host.

## External references

- [RFC 8693: OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693)
- [OpenID Connect Core 1.0: ID Token validation](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)
- [Fly.io OpenID Connect](https://fly.io/docs/security/openid-connect/)
- [Fly Machines API Tokens resource](https://fly.io/docs/machines/api/tokens-resource/)
- [GitHub Actions OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect)
- [GitHub App installation access tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
