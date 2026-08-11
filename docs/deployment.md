# Deployment

This public repository owns the broker source, tests, documentation, public-safe Wrangler templates, and the source side of the release handoff. It does not own credentials, production routes, Cloudflare account identifiers, deployment overlays, or deployment execution.

## One App per deployment

`@github-app-token-broker/worker` is the sole deployable package and exposes only `POST /token`. Each deployed Worker instance receives one `GITHUB_APP_ID` and one `GITHUB_APP_PRIVATE_KEY`. Deploy a separate instance for another GitHub App. A separate trust or policy domain additionally requires a different reviewed source composition and newly built Worker artifact. Do not add a public App selector or multi-key endpoint.

The source-owned composition seam is `workers/github-app-token-broker/src/configured-token-exchange-composition.ts`. It binds:

- the accepted OIDC Provider Registrations
- the compiled Token Issuance Policy

The configured Worker composition imports this seam, so the build compiles both values into the Worker artifact. Deployments using the same already-compiled artifact cannot inject different registrations or policy through Worker bindings or other runtime configuration. The dependency-injection interface is a construction/test seam, not a deployment configuration surface. A deployment that needs a different registration or policy set may reuse the runtime implementation but must select a different reviewed source composition and build a different artifact.

The deployment environment supplies one GitHub App credential pair, the rate-limit binding, and one non-secret identity binding. `TOKEN_BROKER_AUDIENCE` is the exact non-empty, non-whitespace, single-line scalar accepted in subject tokens. It may be URL-shaped or opaque. Public hostname and route ownership remain in deployment configuration rather than a Worker runtime binding. The audience and App credentials can differ across deployments of the same artifact; provider trust and authorization policy cannot.

## External deployment contract

The deployment system is maintained outside this repository. It must:

1. select and pin a reviewed source revision
2. install with Node 24 and the source repository's pinned Corepack/pnpm version
3. run `node --run check`
4. preserve the source compatibility date and flags unless a reviewed deployment change intentionally updates them
5. supply the deployment-owned Worker name, routes, exact `TOKEN_BROKER_AUDIENCE`, GitHub App ID/private key, rate-limit namespace, and Cloudflare credentials
6. deploy only `workers/github-app-token-broker`
7. smoke-test the routed `POST /token` contract without logging tokens

The deployment system owns the Worker audience and public route. It must bind `TOKEN_BROKER_AUDIENCE` to the exact value requested in Clients' subject tokens and independently verify that Clients send requests to the intended Token Exchange Endpoint. Neither identity nor location may be inferred from an incoming `Host` header.

Source maintenance workflows pin an immutable external action release and explicitly provide their Repository Resource and least-privilege Requested Permissions. The workflow files are authoritative for that caller-side contract. Direct Clients must supply a non-empty scope because the broker has no permission default.

## Public source boundary

Never commit Cloudflare account IDs or tokens, GitHub App IDs or private keys, `.dev.vars`, `.env`, `.wrangler/`, `.local-secrets/`, private deployment overlays, or production route details. Build from tracked files or an explicit archive, not an ambient working directory.
