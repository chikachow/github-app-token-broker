# Security Policy

## Reporting Vulnerabilities

Please report security vulnerabilities privately through GitHub private vulnerability reporting when it is enabled for this repository.

If private vulnerability reporting is unavailable, contact the repository maintainer without opening a public issue. Do not include exploit details, private keys, tokens, session material, or tenant-specific deployment identifiers in public issues, pull requests, or discussions.

## Security Boundary

github-app-token-broker accepts Client-presented OpenID Connect ID Tokens from configured issuers and exchanges only the resulting Verified Subject Tokens for repository-scoped GitHub App installation access tokens. The Client is not authenticated and is not assumed to be the ID Token Subject. The important security properties are:

- issuer trust is configured, not discovered from Client-presented tokens
- the Verified Subject Token is derived only from Subject Token Claims in an ID Token accepted through an exact OIDC Provider Registration and, when non-null, its OIDC ID Token Profile
- the ID Token audience must be the exact single-string value in the deployment-owned `TOKEN_BROKER_AUDIENCE` binding; the binding is a non-empty, non-whitespace, single-line scalar, and the unsupported token-exchange `audience` parameter grants nothing
- the Worker owns no public-location binding and never derives the audience from the incoming URL, `Host`, forwarded headers, or `/token` route
- source workflows pin an immutable external action release and explicitly provide the Repository Resource and Requested Permissions
- the action validates its configured Token Exchange Endpoint URL as a canonical credential-free HTTPS URL before OIDC or broker network I/O, rejects redirects, requires the returned scope to exactly match the explicit requested scope, and never derives or changes the audience from the endpoint; the selected endpoint receives the ID Token subject token and can observe an Installation Access Token when it proxies the request, so the authority controlling `TOKEN_BROKER_URL` is already trusted to obtain and handle those credentials
- OIDC Provider Registrations and Permit Statements are independent, checked-in trust decisions; registration authenticates tokens but never authorizes Installation Access Token Issuance
- the authoritative configured registration and Permit Statement inventory is the checked-in [`configured-token-exchange-composition.ts`](workers/github-app-token-broker/src/configured-token-exchange-composition.ts) and [`configured-token-issuance-policy.ts`](workers/github-app-token-broker/src/policy/configured-token-issuance-policy.ts) source
- Clients must supply exactly one effective canonical Repository Resource; value-less occurrences are omitted, and Subject Token Claims never select the target
- Clients must explicitly supply a non-empty `scope`; the broker rejects omitted and exactly empty scope with `invalid_scope` and never infers Requested Permissions from Claims, policy, App grants, or deployment configuration
- Clients may name structurally valid GitHub permissions, but every Requested Permission must be covered by checked-in Permit Statements
- checked-in Token Issuance Policy Permit Statements must compose Effective Permissions that cover the Requested Permissions for the Verified Subject Token and Repository Resource before a token is issued
- the GitHub App installation independently remains the upper bound on repositories and permissions
- the GitHub App private key remains inside the deployment secret boundary

## Deployment Secrets

Never commit deployment secrets, local `.dev.vars`, `.env`, GitHub App private keys, Cloudflare API tokens, or generated Wrangler state.

The source repository intentionally carries only public-safe Wrangler templates for local development, tests, and dry-runs. Production deployment details, credentials, secret values, and deployment overlays must stay outside this codebase.
