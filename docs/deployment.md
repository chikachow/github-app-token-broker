# Deployment

This public repository owns the broker source, tests, documentation, public-safe Wrangler templates, and the source side of the release handoff. It does not own credentials, production routes, Cloudflare account identifiers, deployment overlays, or deployment execution.

## One App per deployment

Each deployed instance serves one GitHub App and exposes only the token endpoint. Deploy a separate instance for another GitHub App. Do not add a public App selector or multi-key endpoint.

An external deployment owns a TypeScript entrypoint that constructs the broker through either `createGitHubAppTokenExchange` or the Worker convenience factory `createTokenExchangeWorker`, with:

- the accepted OIDC Provider Registrations
- the compiled Token Issuance Policy

The deployment imports the required workspace packages from a pinned source revision and compiles both values into its deployable artifact. The constructor rejects duplicate registrations and Permit Statements that reference an unregistered issuer. Empty registrations with an empty Token Issuance Policy are a valid deny-all composition. Construction performs no network I/O. A Worker deployment points Wrangler `main` at its entrypoint; a Fastify deployment registers the resulting handler in its existing application.

OIDC Provider Registrations and Token Issuance Policy are not Worker bindings, request parameters, or remote configuration. Changing them requires changing reviewed TypeScript and building a new artifact. The source package root has named exports only; it does not provide a default production composition.

The deployment environment supplies one GitHub App credential pair, one explicit Subject-Token Audience, and adapter-specific admission control. The audience is the exact non-empty, non-whitespace, single-line scalar accepted in subject tokens; it may be URL-shaped or opaque. Public hostname and route ownership remain separate from this identity. The audience and App credentials can differ across deployments of the same artifact; provider trust and authorization policy cannot change without rebuilding it. The Worker adapter maps `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, optional `GITHUB_API_BASE_URL`, `TOKEN_BROKER_AUDIENCE`, and `TOKEN_EXCHANGE_RATE_LIMIT`; a Fastify host passes semantic configuration to the core factory and owns admission control outside the plugin.

## Fastify host deployment

`@github-app-token-broker/token-exchange` exposes `createGitHubAppTokenExchange`. Its semantic configuration contains the reviewed composition, `{ appId, privateKey, apiBaseUrl? }`, and the explicit `subjectTokenAudience`; it does not expose environment-variable names or infer audience from `Host`. `@github-app-token-broker/fastify` receives only that prebuilt handler plus standard Fastify registration options such as `prefix`.

The plugin is an encapsulated route adapter, not an application. It owns no listener, lifecycle, health route, content-parser policy outside its encapsulation, or rate limiter. A Fastify deployment must place rate limiting or equivalent admission control before body parsing, at the edge or in a host `onRequest` hook. The host owns `trustProxy` and any use of `request.ip`. The 429 response shape is consequently a deployment contract for Fastify, while the Worker adapter retains the source-defined Cloudflare 429 contract.

A deployment-owned Fastify package should compile its baked composition together with the adapters before packaging, then use pnpm's workspace deploy operation:

```bash
pnpm run build
pnpm --filter <deployment-package> deploy --prod <artifact-directory>
```

The workspace injects workspace packages for pnpm's current deploy implementation and synchronizes injected copies after package builds. This keeps built development consumers current while `pnpm deploy` materializes a standalone production tree. `pnpm run deploy:smoke` builds a representative real composition and Fastify adapter, deploys it to a temporary production artifact, imports the host and broker package roots with Node, exercises `/token`, and type-checks the deployed public interfaces without skipping library checks.

## External deployment contract

The deployment system is maintained outside this repository. It must:

1. select and pin a reviewed source revision
2. install with Node 24 and the source repository's pinned Corepack/pnpm version
3. run the public source checks independently
4. compile a deployment-owned TypeScript entrypoint with reviewed OIDC Provider Registrations and Token Issuance Policy
5. test the exact composition, including accepted and rejected requests, without deriving expectations from the policy under test
6. supply the deployment-owned GitHub App credentials and exact Subject-Token Audience without deriving either identity or endpoint location from `Host`
7. place admission control before body parsing without logging tokens
8. build and package only emitted JavaScript, declarations, and runtime dependencies; Node consumers must not require TypeScript stripping in `node_modules`
9. smoke-test the deployed `POST /token` contract

For the Worker adapter, the deployment must preserve the source compatibility date and flags unless intentionally reviewed, supply the Worker name, routes, exact `TOKEN_BROKER_AUDIENCE`, GitHub App bindings, rate-limit namespace, and Cloudflare credentials, and run a strict Wrangler dry-run against its entrypoint.

For the Fastify adapter, the host must pass the exact audience and semantic GitHub App configuration to `createGitHubAppTokenExchange`, apply edge or application-level admission control before registering or reaching the plugin, compile the baked composition with its application, and use `pnpm deploy --prod` to materialize the built production tree. The host owns process startup, port binding, health checks, logging infrastructure, proxy trust, and its deployment-specific 429 response.

For either adapter, the deployment system owns the public route and must independently verify that Clients request tokens for the configured Subject-Token Audience and send exchanges to the intended Token Exchange Endpoint. Neither identity nor location may be inferred from an incoming `Host` header.

Source maintenance workflows pin an immutable external action release and use its caller-side broker request defaults where appropriate; workflows targeting a different Repository Resource or Requested Permissions explicitly override them. The workflow files are authoritative for that caller-side contract. Direct Clients must supply a non-empty scope because the broker has no permission default.

## Public source boundary

Never commit Cloudflare account IDs or tokens, GitHub App IDs or private keys, `.dev.vars`, `.env`, `.wrangler/`, `.local-secrets/`, private deployment overlays, or production route details. Build from tracked files or an explicit archive, not an ambient working directory.
