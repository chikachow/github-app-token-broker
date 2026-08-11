# github-app-token-broker

`github-app-token-broker` is a narrowly scoped Security Token Service for trusted automation workloads. It authenticates OpenID Connect ID Tokens from configured issuers and performs Installation Access Token Issuance only when Token Issuance Policy permits the resulting Verified Subject Token and Installation Access Token Request.

The only public service route is `POST /token`. The service has no webhook receiver, deployment trigger endpoint, app selector, multi-key endpoint, or client-controlled issuer configuration.

## Architecture

- `workers/github-app-token-broker` is the sole deployable Cloudflare Worker package (`@github-app-token-broker/worker`).
- `packages/oidc` owns the deep ID Token authenticator, exact issuer registrations, discovery/JWK Set validation, bounded caches, and fail-closed error classification.
- `packages/github` owns GitHub App JWT signing, installation lookup, owner binding, and installation-token minting.
- `packages/http` owns bounded request/response body helpers and problem responses.
- Provider packages contain reviewed GitHub Actions and Google service-account ID Token profiles plus source-supported, exact organization-scoped Fly OIDC Provider Registration construction. The default production composition registers only GitHub Actions and Google and contains no Fly Permit Statement.
- `configured-token-exchange-composition.ts` is the small checked-in source/build composition seam for provider registrations and Token Issuance Policy. Those values are compiled into the Worker artifact; the exact Subject-Token Audience, one GitHub App credential pair, and rate limit remain deployment bindings.

The intended model is one GitHub App per deployment. Deployments of the same already-compiled Worker artifact may use different App credentials and Subject-Token Audiences, but they cannot inject different provider registrations or Token Issuance Policies at runtime. A different trust or policy composition may reuse the same runtime implementation, but it requires a different reviewed source composition and newly built Worker artifact. The public API deliberately exposes no App selector.

## `POST /token`

The endpoint implements the repository's RFC 8693 profile using `application/x-www-form-urlencoded` requests:

```http
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
requested_token_type=urn:chikachow:github-app-installation-access-token
resource=https://api.github.com/repos/{owner}/{repo}
subject_token=<openid-connect-id-token>
subject_token_type=urn:ietf:params:oauth:token-type:id_token
scope=contents:read
```

Important invariants:

- issuer trust comes only from checked-in exact OIDC Provider Registrations
- the ID Token must have the deployment's exact single-string `TOKEN_BROKER_AUDIENCE`; the RFC 8693 `audience` parameter is unsupported and grants nothing
- every request names exactly one canonical GitHub Repository Resource
- every request explicitly names a non-empty `scope`; the broker has no default Requested Permissions
- Subject Token Claims never select the target repository
- authentication never grants authorization; independently complete Permit Statements must cover the requested resource and every permission
- installation lookup must return an installation whose `account.login` matches the requested owner, case-insensitively, before minting
- the configured GitHub App installation remains the upper bound on repositories and permissions
- OAuth token responses are non-cacheable and raw subject/access tokens are not logged

See [the service contract](docs/service-contract.md) for complete request, response, error, provider, and policy behavior; [implementation](docs/implementation.md) for code boundaries; and [deployment](docs/deployment.md) for the public-source/private-deploy interface.

## Configuration

The Worker consumes one App identity per deployment:

- `GITHUB_APP_ID`: non-secret GitHub App identifier
- `GITHUB_APP_PRIVATE_KEY`: Worker secret or Secrets Store binding containing its PKCS#8 private key
- `GITHUB_API_BASE_URL`: public-safe GitHub API base URL, normally `https://api.github.com`
- `TOKEN_BROKER_AUDIENCE`: required non-secret exact scalar subject-token audience; initially `https://cyspbot.chikachow.org`
- `TOKEN_EXCHANGE_RATE_LIMIT`: Cloudflare rate-limit binding

The audience must be a non-empty, non-whitespace, single-line string and is validated before request routing. It is an identity, not a Worker location binding: the Worker never derives it from the incoming URL, `Host`, forwarded headers, or `/token` route. Provider registrations and Token Issuance Policy are source-reviewed values in [`configured-token-exchange-composition.ts`](workers/github-app-token-broker/src/configured-token-exchange-composition.ts) and are compiled into the Worker artifact; neither is a runtime deployment binding or Client input.

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

This public repository does not deploy the service. The dedicated private `chikachow/github-app-token-broker-deploy` repository exists and is preparing a pipeline that pins a reviewed source commit, runs the full source checks, supplies deployment-owned identifiers/routes/secrets, deploys the one Worker, and smoke-tests `POST /token`.

After successful CI on `main`, `.github/workflows/run-github-app-token-broker-deploy-update.yml` uses an immutable release of `chikachow/cyspbot-app-token-action` to request an explicitly scoped `actions:write` installation token for that private repository and dispatch its `update-github-app-token-broker.yml` workflow. The action always requests GitHub OIDC for the fixed logical audience `https://cyspbot.chikachow.org`. Its default POST destination is that audience plus `/token`; optional source-repository variable `TOKEN_BROKER_URL` overrides only the exact HTTPS destination and never the audience. Both source workflows supply their resource and scope explicitly, so the broker remains the authority that validates every requested target and permission. Repository creation is complete, but the deployment pipeline must be accepted, its secrets and configuration must be provisioned, and an initial broker deployment must establish the public route before this handoff can operate. The source repository does not create or configure deployment resources and does not deploy a Worker.

## History

This repository began from the exact `chikachow/cyspbot` `origin/main` commit `0c6dc8c5ef37b2fa3cf5a4757eaf67369ba780e2`. The commit ancestry was preserved directly without GitHub fork metadata; subsequent commits intentionally diverge as the standalone broker.

## External references

- [RFC 8693: OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693)
- [OpenID Connect Core 1.0: ID Token validation](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)
- [Fly.io OpenID Connect](https://fly.io/docs/security/openid-connect/)
- [Fly Machines API Tokens resource](https://fly.io/docs/machines/api/tokens-resource/)
- [GitHub Actions OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect)
- [GitHub App installation access tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
