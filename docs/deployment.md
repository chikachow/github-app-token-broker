# Deployment

This public repository owns the broker source, tests, documentation, public-safe Wrangler templates, and the source side of the release handoff. It does not own credentials, production routes, Cloudflare account identifiers, deployment overlays, or deployment execution.

## One App per deployment

`@github-app-token-broker/worker` is the sole deployable package and exposes only `POST /token`. Each deployed Worker instance receives one `GITHUB_APP_ID` and one `GITHUB_APP_PRIVATE_KEY`. Deploy a separate instance for another GitHub App. A separate trust or policy domain additionally requires a different reviewed source composition and newly built Worker artifact. Do not add a public App selector or multi-key endpoint.

The source-owned composition seam is `workers/github-app-token-broker/src/configured-token-exchange-composition.ts`. It binds:

- the accepted OIDC Provider Registrations
- the compiled Token Issuance Policy

The configured Worker composition imports this seam, so the build compiles both values into the Worker artifact. Deployments using the same already-compiled artifact cannot inject different registrations or policy through Worker bindings or other runtime configuration. The dependency-injection interface is a construction/test seam, not a deployment configuration surface. A deployment that needs a different registration or policy set may reuse the runtime implementation but must select a different reviewed source composition and build a different artifact.

The deployment environment supplies one GitHub App credential pair, the rate-limit binding, and one non-secret identity binding. `TOKEN_BROKER_AUDIENCE` is the exact non-empty, non-whitespace, single-line scalar accepted in subject tokens; its initial value is `https://cyspbot.chikachow.org`. It may be URL-shaped or opaque. Public hostname and route ownership remain in deployment configuration rather than a Worker runtime binding. The audience and App credentials can differ across deployments of the same artifact; provider trust and authorization policy cannot.

## Dedicated private deployment repository

The deployment owner is the existing private `chikachow/github-app-token-broker-deploy` repository. Its `main` branch was bootstrapped with deployment documentation; its pipeline remains under review. The accepted `update-github-app-token-broker.yml` workflow must:

1. accept `workflow_dispatch` on `main`
2. select and pin a reviewed commit from `chikachow/github-app-token-broker`
3. install with Node 24 and the source repository's pinned Corepack/pnpm version
4. run `node --run check`
5. preserve the source compatibility date and flags unless a reviewed deployment change intentionally updates them
6. supply the deployment-owned Worker name, routes, exact `TOKEN_BROKER_AUDIENCE`, GitHub App ID/private key, rate-limit namespace, and Cloudflare credentials
7. deploy only `workers/github-app-token-broker`
8. smoke-test the routed `POST /token` contract without logging tokens

The source workflow `run-github-app-token-broker-deploy-update.yml` is triggered manually or after successful `ci` on a push to `main`. It requests only `actions:write` for `chikachow/github-app-token-broker-deploy`, then runs `update-github-app-token-broker.yml` on that repository's `main` branch. The checked-in Token Issuance Policy contains matching exact workflow claims and target permissions.

Both source maintenance workflows pin the same immutable release of `chikachow/cyspbot-app-token-action`. The action always requests GitHub OIDC for the fixed logical audience `https://cyspbot.chikachow.org`; callers cannot override that identity value. Its default Token Exchange Endpoint URL is `https://cyspbot.chikachow.org/token`. Optional repository variable `TOKEN_BROKER_URL` is passed as `cyspbot-token-url` and changes only the exact POST destination, allowing a route migration without an identity migration. The action requires a canonical credential-free HTTPS URL with no query or fragment, rejects redirects, validates the complete response shape and exact requested scope, masks the token, and writes only token outputs. The selected endpoint receives the ID Token subject token and can observe an Installation Access Token when it proxies the request; the authority controlling the URL is already trusted to obtain and handle those credentials. Both workflows explicitly provide their repository resource and least-privilege scope. The action's fallback `contents:write pull_requests:write` scope remains a caller convenience only: direct Clients must supply a non-empty scope because the broker has no permission default.

The private deploy pipeline owns the Worker audience and public route. Its Worker overlay must bind `TOKEN_BROKER_AUDIENCE=https://cyspbot.chikachow.org`, matching the action's fixed audience. It may leave source variable `TOKEN_BROKER_URL` unset when the default endpoint reaches the intended route, or set it to the exact canonical HTTPS destination when routing requires an override. Deployment validation must compare the Worker binding with the action's documented audience and separately prove the effective action POST destination matches the intended route before enabling source workflows. A route migration may retain the stable audience and change only routing plus the optional URL override; changing the logical audience requires a coordinated action and deployment release. Neither identity nor location may be inferred from an incoming `Host` header.

The private deploy repository also consumes `test/support/token-exchange-oidc-node-fixture.ts` from its pinned source checkout when it needs a deterministic GitHub Actions OIDC discovery, JWK Set, and signing fixture. The module exports `tokenExchangeOidcNodeFixture` with `privateKeyPem` and an `outboundService` fetch handler. It is a Node-only test seam: it must never supply production bindings or deployment secrets, and the deploy repository should import it only in validation tests against the pinned source revision.

The private repository now exists, but the source-side handoff remains intentionally non-operational until its pipeline is accepted and the required secrets, bindings, routes, and source-repository configuration are provisioned. This source repository does not configure those resources, dispatch an unaccepted workflow, or deploy anything.

## Migration order

Before the original service removes its token endpoint:

1. accept and validate the private repository's pinned-source update/deploy pipeline
2. provision the dedicated GitHub App credentials, Cloudflare secrets and bindings, production route configuration, and required repository configuration
3. deploy and smoke-test the broker at its final origin
4. verify the Worker audience exactly matches the action's fixed audience, set optional source repository variable `TOKEN_BROKER_URL` only when the default action endpoint does not name the intended route, and coordinate route and identity cutovers explicitly
5. verify every configured workload and least-privilege policy path against the new service
6. only then remove the old endpoint and deployment wiring

## Public source boundary

Never commit Cloudflare account IDs or tokens, GitHub App IDs or private keys, `.dev.vars`, `.env`, `.wrangler/`, `.local-secrets/`, private deployment overlays, or production route details. Build from tracked files or an explicit archive, not an ambient working directory.
