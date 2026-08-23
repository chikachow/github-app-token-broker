# Deployment

This public repository owns the broker source, tests, documentation, public-safe Wrangler templates, and the source side of the release handoff. It does not own credentials, production routes, Cloudflare account identifiers, deployment overlays, or deployment execution.

## One App per deployment

`@github-app-token-broker/worker` is the sole Worker package. Its only public
HTTP route is `POST /token`; it also exports the internal
`GitHubAppInformationEntrypoint` for trusted service-binding RPC. Each deployed
Worker instance receives one `GITHUB_APP_ID` and one
`GITHUB_APP_PRIVATE_KEY`. Deploy a separate instance for another GitHub App. Do
not add a public App selector or multi-key endpoint.

An external deployment owns a TypeScript entrypoint that:

- default-exports the result of calling `createTokenExchangeWorker`; and
- re-exports `GitHubAppInformationEntrypoint` from
  `@github-app-token-broker/worker` as a named export.

The deployment calls `createTokenExchangeWorker` with:

- the accepted OIDC Provider Registrations
- the compiled Token Issuance Policy

The Worker adapter constructs the runtime-neutral `createGitHubAppTokenExchange` handler from that reviewed composition and the deployment bindings. Its semantic GitHub App interface contains only `appId` and `privateKey`; the GitHub API destination is fixed inside the GitHub module and cannot be supplied by either factory.

The deployment imports the required workspace packages from a pinned source revision, compiles both values into the Worker artifact, and points its Wrangler `main` at that entrypoint. `createTokenExchangeWorker` rejects duplicate registrations and Permit Statements that reference an unregistered issuer during construction. Empty registrations with an empty Token Issuance Policy are a valid deny-all composition. Construction performs no network I/O.

OIDC Provider Registrations and Token Issuance Policy are not Worker bindings, request parameters, or remote configuration. Changing them requires changing reviewed TypeScript and building a new artifact. The source package root has named exports only; it does not provide a default production composition.

The deployment environment supplies one GitHub App credential pair, the rate-limit binding, and one non-secret identity binding. `TOKEN_BROKER_AUDIENCE` is the exact non-empty, non-whitespace, single-line Subject-Token Audience accepted in subject tokens. It may be URL-shaped or opaque. Public hostname and route ownership remain in deployment configuration rather than a Worker runtime binding. The GitHub API destination is fixed to `https://api.github.com`; it is not deployment configuration. The audience and App credentials can differ across deployments of the same artifact; provider trust and authorization policy cannot change without rebuilding it.

The optional runtime `observe` adapter acknowledges mandatory high-level Token Exchange
observations by returning `Promise<void>`. The broker does not return a token until the pre-mint
intent and post-mint success observations are acknowledged. The default console adapter's
fulfilled promise establishes only that its console call completed; it is not durable storage. A
deployment that requires durable audit acknowledgement must inject an adapter whose promise
fulfills only after its chosen sink confirms persistence. Sink choice, idempotency, retry, and
timeout semantics are deployment concerns and are not supplied by this repository. Optional OIDC
remote-document diagnostics use the separate synchronous `observeOidcDiagnostic` callback and
must not be wired to the mandatory async adapter.

## Node 24 and Fastify 5 host adapter

`@github-app-token-broker/fastify` mounts a prebuilt `TokenExchangeHandler` into a Fastify 5
application. Its only plugin-specific option is `tokenExchange`; use Fastify's standard `prefix`
registration option when the host does not expose `/token` at the application root.

```ts
import { githubAppTokenExchangePlugin } from "@github-app-token-broker/fastify";
import { createGitHubAppTokenExchange } from "@github-app-token-broker/token-exchange";
import Fastify from "fastify";

const tokenExchange = createGitHubAppTokenExchange(deploymentOwnedConfiguration);
const app = Fastify(deploymentOwnedFastifyOptions);

app.addHook("onRequest", deploymentOwnedAdmissionHook);
await app.register(githubAppTokenExchangePlugin, {
  prefix: "/automation",
  tokenExchange,
});
await app.listen(deploymentOwnedListenOptions);
```

The host owns handler construction and credentials, Subject-Token Audience, admission and rate
limiting, request identity, logger construction and transport, `trustProxy`, listener options,
startup, shutdown, and signal handling. The plugin removes inherited content parsers only inside
its encapsulated scope, buffers form bodies up to the deep module's public limit, and maps only
Fastify's media-type, content-length, and body-limit parser errors to the stable OAuth response.
Sibling routes and parsers remain unchanged.

Mandatory observations are awaited through the request logger. A synchronous request-logger
failure rejects the mandatory callback so the deep handler fails closed; logger invocation does
not itself claim durable persistence. Optional OIDC diagnostic logging remains best effort.

`test/deployment/fastify-host` is a deny-all production-consumer fixture, not a production
composition. `pnpm run node-deploy:check` builds and production-deploys that fixture into a
temporary directory, verifies package-root ESM and declarations without source aliases, starts it
only on an ephemeral loopback socket, and then removes it.

## External deployment contract

The deployment system is maintained outside this repository. It must:

1. select and pin a reviewed source revision
2. install with Node 24 and the source repository's pinned Corepack/pnpm version
3. run the public source checks independently
4. compile a deployment-owned TypeScript entrypoint with reviewed OIDC Provider Registrations and Token Issuance Policy, and re-export `GitHubAppInformationEntrypoint`
5. test the exact composition, including accepted and rejected requests, without deriving expectations from the policy under test
6. preserve the source compatibility date and flags unless a reviewed deployment change intentionally updates them
7. supply the deployment-owned Worker name, routes, exact `TOKEN_BROKER_AUDIENCE`, GitHub App ID/private key, rate-limit namespace, and Cloudflare credentials
8. run a strict dry-run against the deployment-owned entrypoint
9. smoke-test the routed `POST /token` contract without logging tokens
10. exercise `GitHubAppInformationEntrypoint` through an explicitly configured trusted named service binding; each concrete consumer must test its exact production binding configuration and the absence of any public HTTP route to that entrypoint
11. when durable observation is required, inject and test an acknowledgement adapter whose promise resolves only after the selected sink confirms persistence

The deployment system owns the Worker audience and public route. It must bind `TOKEN_BROKER_AUDIENCE` to the exact value requested in Clients' subject tokens and independently verify that Clients send requests to the intended Token Exchange Endpoint. Neither identity nor location may be inferred from an incoming `Host` header.

Source maintenance workflows pin an immutable external action release and use its caller-side broker request defaults where appropriate; workflows targeting a different Repository Resource or Requested Permissions explicitly override them. The workflow files are authoritative for that caller-side contract. Direct Clients must supply a non-empty scope because the broker has no permission default.

## Public source boundary

Never commit Cloudflare account IDs or tokens, GitHub App IDs or private keys, `.dev.vars`, `.env`, `.wrangler/`, `.local-secrets/`, private deployment overlays, or production route details. Build from tracked files or an explicit archive, not an ambient working directory.
