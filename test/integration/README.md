# Container integration suite

From the repository root, with the pinned Node 24 runtime and Docker Compose:

```sh
export COMPOSE_PROFILES=fastify # Or worker.
export COMPOSE_PROJECT_NAME=broker-integration-$COMPOSE_PROFILES-$$
export COMPOSE_FILE=test/integration/compose.yml
docker compose up --build --wait --wait-timeout 60 oidc github
node --run test:integration
docker compose down --volumes --remove-orphans
```

Run these steps for each host. `COMPOSE_PROFILES` selects exactly one of `fastify`
or `worker`. The Node command runs the host driver against the prepared stack;
it does not build fixtures or remove the stack. Always run the final cleanup
command after completion, failure, or interruption. Separate shells with distinct
Compose project names can run the hosts concurrently because they share no
mutable fixture state.

OrbStack supports these commands. Dependencies install and artifacts build inside
Linux containers; the host driver uses only Node built-ins and Docker CLI. Host
`node_modules` and local credentials are excluded from the image. No GitHub or
Cloudflare account is needed. The cleanup command removes the project's
containers, network, and generated-key volume, retaining the image for reuse.
Add `--rmi all` to remove that project's image too, as CI does. Reusable Docker
build cache remains. Container logs are capped at 5 MB per service.

## Deployment artifacts and services

The Dockerfile installs frozen dependencies and builds the public packages.
Fastify's synthetic deployment in `test/deployment/integration-fastify` bundles
the reviewed composition and broker code,
then `pnpm deploy --prod` produces `/fastify` with emitted JavaScript and production
dependencies. Its container starts `node dist/normal.js` from that directory.
The separate `test/deployment/fastify-host` fixture belongs to
`node-deploy:check`: it validates package-root imports and declarations with a
deny-all composition. The integration fixture exercises real issuance and
upstream failures from its bundled deployment.

The Dockerfile emits the Worker through `wrangler deploy --dry-run`. Its container
runs Wrangler/Workerd directly with `--no-bundle` against that emitted JavaScript.
Both commands use the source Wrangler configuration, preserving its compatibility
settings and bindings; both compiled variants retain the named RPC export.
Both hosts receive disposable App credentials at runtime. Separate build outputs
provide the deliberately failing observation adapters.

| Component            | Responsibility                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `prepare`            | Generates fresh signing keys, CA, and hostname-specific TLS certificates in a disposable volume.                       |
| `oidc`               | Serves discovery and JWKS over HTTPS and signs synthetic GitHub Actions ID Tokens.                                     |
| `github`             | Verifies App JWTs and literal repository/permission narrowing before minting disposable tokens over HTTPS.             |
| `fastify` / `worker` | Starts the selected deployment artifact with its native outbound Fetch implementation.                                 |
| Host Node driver     | Recreates the selected broker container, sends HTTP requests, and checks responses plus independent upstream evidence. |

`oidc.mjs` and `github.mjs` own their respective protocol responses and scenario
controls. `mocks/server.mjs` shares only transport, readiness, bounded JSON reading,
and sanitized evidence collection. The driver and mocks import no broker helpers.

Compose health checks own readiness. The driver uses
`docker compose up --no-deps --force-recreate --wait` when a scenario needs a fresh
broker: cold OIDC retrieval failures, an absent test CA, a different compiled
observation adapter, either body-limit check, or cache and rotation state. The
scenario structure uses fifteen broker starts per host. Ordinary protocol cases
share one broker and use non-cacheable OIDC responses and distinct Worker client IPs.
Cache and rotation checks deliberately retain one container throughout their
state transitions. No broker reset route or custom process supervisor is needed.

Each body-limit check starts a fresh broker on both hosts. The pinned local
Wrangler/Miniflare proxy returned `500 Network connection lost` in a repeated
known-length/chunked oversized-body probe; a bare Worker that rejects without
consuming the body reproduced this without broker code. These checks establish
oversized-body rejection from a fresh
listener, without establishing repeated oversized-request recovery or production
edge behavior.

## Network and trust

The broker and mocks share a standard bridge network. DNS aliases route
`api.github.com` and `token.actions.githubusercontent.com` to the HTTPS mocks,
preserving production origin and hostname checks. Only broker processes receive
`NODE_EXTRA_CA_CERTS`; the suite requires TLS failure when that CA is absent.
Wrangler telemetry and optional Cloudflare request metadata retrieval are disabled.

The driver discovers dynamically assigned ports bound to `127.0.0.1`: the broker's
HTTP listener and each mock's separate HTTP control listener. The bridge permits
outbound access; this suite does not enforce an egress-denial boundary. Control
listeners are test infrastructure and never part of the broker's public routes.

## Scenarios and evidence

The shared suite covers signed issuance, exact mint narrowing, signature and
Claim rejection, provider profile rejection, policy denials before GitHub I/O,
duplicate form parameters, known-length and chunked request limits, unsupported
methods, untrusted TLS, OIDC redirects and malformed/oversized documents, GitHub
redirects, installation-owner mismatch, rate-limit/unavailable responses, rejected
or malformed mint responses, real response-body deadlines, document reuse, and
unknown-key refresh cooldown followed by rotation. Worker-specific coverage
exercises its local admission binding.

A separate failing logger/observer proves that post-mint observation failure
withholds the token and awaits authenticated revocation. The GitHub mock holds
the revocation response until the driver releases it. All other cases use the
normal deployment artifacts.

Error expectations follow [the service contract](../../docs/service-contract.md),
including invalid discovery metadata (`400`), unusable JWKS (`503`), rejected
GitHub redirects (`500`), and installation-owner mismatch (`502`). Every failure
requires evidence of the actual upstream stage reached. JWKS size cases contain
valid signing keys with 32 KiB and 1 MiB of additive padding, distinguishing size
enforcement from malformed-document rejection.

Container startup, the ten-second key-refresh cooldown, and real five-/ten-second
network deadlines determine runtime. This lane does not replace source coverage
or validate live provider behavior, deployment inventory, distributed edge
admission, a deployment-owned RPC binding, or production logging durability.

## Debugging

After the test command, inspect the retained stack before cleanup:

```sh
docker compose logs --tail 100
node --run test:integration
```

The Node command reruns the suite. Finish with the cleanup command above. Never
share mutable mock controls between concurrent test runs: use distinct Compose
project names. Image tags also include that name, so separate checkouts cannot
replace each other's image.

## CI

[Fastify](../../.github/workflows/ci-integration-fastify.yml) and
[Worker](../../.github/workflows/ci-integration-worker.yml) have separate reusable
workflows. Each sets up the pinned Node runtime, starts Compose fixtures, runs the
Node driver, collects failure logs, and removes the stack with `always()`.
The test step uses a Linux process group and shell traps to stop any surviving
Docker command descendants before the cleanup step can remove their stack.
[compose.yml](compose.yml) owns the shared build, service commands, readiness,
network, and volume configuration for CI and local runs.

Each job owns its image and stack; CI publishes no image and needs no registry
write or OIDC-token permission. The aggregate `ci` job requires both workflows
alongside existing checks; a failure in one host does not cancel the other.

## Extending the suite

Keep expectations and upstream validation independent of broker helpers. Add a
scenario when real host, transport, or state-transition evidence adds something
beyond a focused test. For failures, assert where I/O stopped: an OAuth error
alone can pass for the wrong reason.
