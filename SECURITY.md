# Security Policy

## Reporting Vulnerabilities

Please report security vulnerabilities privately through GitHub private vulnerability reporting when it is enabled for this repository.

If private vulnerability reporting is unavailable, contact the repository maintainer without opening a public issue. Do not include exploit details, private keys, tokens, session material, or tenant-specific deployment identifiers in public issues, pull requests, or discussions.

## Security Boundary

github-app-token-broker accepts Client-presented OpenID Connect ID Tokens from configured issuers and exchanges only the resulting Verified Subject Tokens for GitHub App installation access tokens narrowed to one selected repository and the Requested Permissions. Requested permission keys may include GitHub organization- or account-level permissions; repository selection and permission narrowing are independent controls. The Client is not authenticated and is not assumed to be the ID Token Subject. The important security properties are:

- issuer trust is configured, not discovered from Client-presented tokens
- OpenID Provider Configuration and JWK Set requests reject redirects and use a broker-owned fixed five-second deadline spanning response headers and complete bounded body consumption
- the Verified Subject Token is derived only from an immutable copy of Subject Token Claims in an ID Token accepted through an exact OIDC Provider Registration; a non-null OIDC ID Token Profile evaluates that immutable verified snapshot before the separate Token Issuance Policy decision
- the ID Token audience must be the exact single-string value in the deployment-owned `TOKEN_BROKER_AUDIENCE` binding; the binding is a non-empty, non-whitespace, single-line scalar, and the unsupported token-exchange `audience` parameter grants nothing
- the Worker owns no public-location binding and never derives the audience from the incoming URL, `Host`, forwarded headers, or `/token` route
- source workflows pin an immutable external action release; each invocation uses the pinned action's broker request configuration, with workflows explicitly overriding the Repository Resource and Requested Permissions where needed
- the action validates its configured Token Exchange Endpoint URL as a canonical credential-free HTTPS URL before OIDC or broker network I/O, rejects redirects, requires the returned scope to exactly match the explicit requested scope, and never derives or changes the audience from the endpoint; the selected endpoint (the pinned action's default unless `cyspbot-token-url` is explicitly supplied) receives the ID Token subject token and can observe an Installation Access Token when it proxies the request, so the authority controlling that action configuration is already trusted to obtain and handle those credentials
- OIDC Provider Registrations and Permit Statements are independent, reviewed build-time trust decisions; registration authenticates tokens but never authorizes Installation Access Token Issuance
- each Worker artifact contains its exact OIDC Provider Registration and Permit Statement inventory; the public source provides the typed composition Interface but no production inventory
- Clients must supply exactly one effective canonical Repository Resource; value-less occurrences are omitted, and Subject Token Claims never select the target
- Clients must explicitly supply a non-empty `scope`; the broker rejects omitted and exactly empty scope with `invalid_scope` and never infers Requested Permissions from Claims, policy, App grants, or deployment configuration
- Clients may name structurally valid GitHub permissions, but every Requested Permission must be covered by compiled Permit Statements
- compiled Token Issuance Policy Permit Statements must compose Effective Permissions that cover the Requested Permissions for the Verified Subject Token and Repository Resource before a token is issued
- the GitHub App installation independently remains the upper bound on repositories and permissions
- the GitHub App private key remains inside the deployment secret boundary
- GitHub API requests are restricted to `https://api.github.com` and to a broker-owned 10-second deadline spanning response headers and the complete bounded response body
- Installation Access Token values are treated as opaque credentials; the broker sends no temporary stateful-token override and accepts both GitHub's opaque and JWT-shaped token formats

The GitHub App Information RPC is a separate privileged capability boundary:

- only an explicitly configured, trusted Cloudflare Worker service binding may reach it
- it is read-only and exposes no public HTTP route
- it never returns the GitHub App private key or an App JWT
- it never mints or returns an Installation Access Token
- it does not enumerate repositories accessible to an installation

## Deployment Secrets

Never commit deployment secrets, local `.dev.vars`, `.env`, GitHub App private keys, Cloudflare API tokens, or generated Wrangler state.

The source repository intentionally carries only public-safe Wrangler templates for local development, tests, and dry-runs. Production runtime trust and deployment configuration—including OIDC Provider Registrations, Permit Statements, trusted RPC service bindings, audience, App identity, routes, account or namespace identifiers, credentials, and secret values—must stay outside this codebase. Source workflows may name an external release-handoff repository and workflow as intentionally public, least-privilege coordination metadata; this does not make production runtime inventory source-owned.
