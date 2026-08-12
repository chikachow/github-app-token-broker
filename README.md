# github-app-token-broker

`github-app-token-broker` is a narrowly scoped Security Token Service for trusted automation workloads. It authenticates OpenID Connect ID Tokens from configured issuers and performs Installation Access Token Issuance only when Token Issuance Policy permits the resulting Verified Subject Token and Installation Access Token Request.

The only public service route is `POST /token`. The service has no webhook receiver, deployment trigger endpoint, app selector, multi-key endpoint, or client-controlled issuer configuration.

## Architecture

- `workers/github-app-token-broker` is the sole deployable Cloudflare Worker package (`@github-app-token-broker/worker`).
- `packages/oidc` owns the deep ID Token authenticator, OIDC Provider Registration validation, discovery/JWK Set validation, bounded caches, and fail-closed error classification.
- `packages/github` owns Installation Access Token Request normalization, GitHub App JWT signing, installation lookup, owner binding, and installation-token minting.
- `packages/token-issuance-policy` owns Permit Statement compilation and evaluation.
- `packages/http` owns bounded request/response body helpers and problem responses.
- Provider packages contain reviewed GitHub Actions and Google service-account registrations plus exact organization-scoped Fly OIDC Provider Registration construction.
- `createTokenExchangeWorker` accepts OIDC Provider Registrations and a compiled Token Issuance Policy. An external deployment owns that TypeScript composition and compiles it into its Worker artifact. The source Wrangler template instead uses a generic deny-all entrypoint.

The intended model is one GitHub App per deployment. OIDC Provider Registrations and Token Issuance Policy are build-time composition values, while App credentials, Subject-Token Audience, and rate limit are deployment bindings. Changing trust or policy requires a reviewed composition change and a newly built Worker artifact. The public API deliberately exposes no App selector or runtime policy loader.

## `POST /token`

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

- issuer trust comes only from exact OIDC Provider Registrations compiled into the Worker artifact
- the ID Token must have the deployment's exact single-string `TOKEN_BROKER_AUDIENCE`; the RFC 8693 `audience` parameter is unsupported and grants nothing
- every request names exactly one canonical GitHub Repository Resource
- every request explicitly names a non-empty `scope`; the broker has no default Requested Permissions
- Subject Token Claims never select the target repository
- authentication never grants authorization; independently complete Permit Statements must cover the requested resource and every permission
- installation lookup must return an installation whose `account.login` matches the requested owner, case-insensitively, before minting
- the configured GitHub App installation remains the upper bound on repositories and permissions
- OAuth token responses are non-cacheable and raw subject/access tokens are not logged

See [the service contract](docs/service-contract.md) for complete request, response, error, provider, and policy behavior; [implementation](docs/implementation.md) for code boundaries; and [deployment](docs/deployment.md) for the public-source/external-deployment interface.

## Configuration

The Worker consumes one App identity per deployment:

- `GITHUB_APP_ID`: non-secret GitHub App identifier
- `GITHUB_APP_PRIVATE_KEY`: Worker secret or Secrets Store binding containing its PKCS#8 private key
- `GITHUB_API_BASE_URL`: public-safe GitHub API base URL, normally `https://api.github.com`
- `TOKEN_BROKER_AUDIENCE`: required non-secret exact scalar Subject-Token Audience supplied by the deployment
- `TOKEN_EXCHANGE_RATE_LIMIT`: Cloudflare rate-limit binding

The audience must be a non-empty, non-whitespace, single-line string and is validated before request routing. It is an identity, not a Worker location binding: the Worker never derives it from the incoming URL, `Host`, forwarded headers, or `/token` route. OIDC Provider Registrations and Token Issuance Policy are reviewed TypeScript supplied to `createTokenExchangeWorker` and compiled into the artifact; neither is a runtime deployment binding or Client input.

## Local development

Use Node 24 and the pinned pnpm version:

```bash
fnm exec --using=24 corepack pnpm install --frozen-lockfile
fnm exec --using=24 corepack pnpm run check
```

For local Worker development, copy `.dev.vars.example` to `.dev.vars`, add a local App ID and private key, then run:

```bash
fnm exec --using=24 corepack pnpm run dev
```

Do not commit keys, `.dev.vars`, `.env`, `.wrangler/`, `.local-secrets/`, or private deployment overlays.

## Deployment boundary

This public repository does not deploy the service. A deployment system outside this repository must pin a reviewed source revision, run the source checks, supply deployment-owned configuration and secrets, deploy the Worker, and verify `POST /token`.

## External references

- [RFC 8693: OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693)
- [OpenID Connect Core 1.0: ID Token validation](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)
- [Fly.io OpenID Connect](https://fly.io/docs/security/openid-connect/)
- [Fly Machines API Tokens resource](https://fly.io/docs/machines/api/tokens-resource/)
- [GitHub Actions OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect)
- [GitHub App installation access tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
