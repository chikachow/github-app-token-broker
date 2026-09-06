# Container integration suite

From the repository root, with Docker and Compose running:

```sh
node --run test:integration
# Or select one host:
node --run test:integration -- fastify
node --run test:integration -- worker
```

The default command runs Fastify then Worker, each in its own Compose project
with fresh OIDC/GitHub fixtures and keys. A failed host does not skip the other;
interruption stops the run. Explicit host commands can run concurrently because
they share no mutable fixture state.

OrbStack supports these commands. It installs the frozen dependencies and builds
inside Linux containers; host `node_modules` and local credentials are excluded
from the build context. No GitHub or Cloudflare account is needed. The command
returns the test result and removes its own image, containers, network, and
ephemeral fixture-key volume, including on SIGINT/SIGTERM. Reusable Docker build
cache remains. Container logs are capped at 5 MB per service.

## Services and boundaries

| Service   | Responsibility                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prepare` | Generates fresh RSA signing keys, CA, and hostname-specific TLS certificates in a disposable volume.                                                                                 |
| `oidc`    | Serves discovery and JWKS over HTTPS and signs synthetic GitHub Actions ID Tokens. Its separate HTTP control port selects failure scenarios and exposes a token-free request ledger. |
| `github`  | Serves the fixed GitHub API origin over HTTPS. Independently verifies App JWTs and exact repository/permission narrowing before minting disposable tokens.                           |
| `broker`  | Runs the selected Fastify or Wrangler/Workerd host through public packages with a synthetic compiled policy and native Fetch.                                                        |
| `tests`   | Drives real HTTP requests and checks public responses plus independent upstream evidence.                                                                                            |

The selected broker runs a fixture-only supervisor. Its separate control port
restarts the OS process between independent scenarios, removing OIDC failure
backoff and cache state. Shutdown waits for the whole owned process group,
with a bounded forced-kill fallback if descendants outlive the launcher.
Shutdown is terminal: it cancels an active reset, prevents further starts, and
waits for that reset before stopping the remaining host. Cache and rotation scenarios explicitly keep the same
process. These control interfaces are test infrastructure and are never part of
the broker's public routes.

Compose uses an internal network and publishes no ports. Only the test
processes trust the generated CA. `api.github.com` and
`token.actions.githubusercontent.com` resolve to the fixtures through network
aliases, preserving production origin validation. Wrangler telemetry and optional
Cloudflare request metadata retrieval are disabled in this isolated environment.

## Scenario selection

`host-lifecycle.mjs` drives the actual supervisor with a gated disposable Node
listener. It covers SIGINT/SIGTERM during reset shutdown and startup, repeated
signals, process-group removal, and supervisor exit. It runs alongside the
protocol suite in the isolated Compose driver.

The shared suite covers signed issuance, exact mint narrowing, signature and
Claim rejection, provider profile rejection, policy denials before GitHub I/O,
duplicate form parameters, known-length and chunked request limits, unsupported
methods, untrusted TLS, OIDC redirects and malformed/oversized documents, GitHub
redirects, installation-owner mismatch, rate-limit/unavailable responses, rejected
or malformed mint responses, real response-body deadlines, document reuse, and
unknown-key refresh cooldown followed by rotation. A failing test logger/observer
also proves that post-mint observation failure withholds the token and waits for
authenticated revocation; the GitHub fixture gates its response until the driver
releases it. The default host compositions are used for the remaining cases. Worker-specific coverage
exercises its local admission binding.

Error expectations follow [the service contract](../../docs/service-contract.md),
including the distinction between invalid discovery metadata (`400`) and an
unusable JWKS (`503`). A rejected GitHub redirect follows the existing unclassified
failure mapping (`500`); owner mismatch follows invalid successful representation
mapping (`502`). Fixture ledgers require the actual stage to have been reached.
The JWKS size cases use valid signing keys with 32 KiB and 1 MiB of additive
padding, distinguishing size enforcement from rejection of malformed documents.

Runtime depends on the selected host and machine. Ten-second key-refresh cooldowns and real five-/ten-second network
deadlines account for much of that time. This is a transport lane, not a source
coverage substitute. It does not validate live provider behavior, deployment
inventory, distributed edge admission, or production logging durability.

## Debugging

To retain an explicitly named stack while investigating:

```sh
export INTEGRATION_HOST=fastify # Or worker.
docker compose -p broker-integration-debug -f test/integration/compose.yml up --build -d
docker compose -p broker-integration-debug -f test/integration/compose.yml logs -f tests
docker compose -p broker-integration-debug -f test/integration/compose.yml down --volumes --remove-orphans --rmi all
```

Use the final command when finished; the ordinary npm script performs this
cleanup automatically. To repeat a scenario suite in a retained stack, recreate
the `tests` service. Each host restarts between cases; the intentional stateful
checks stay within one case. Never share one set of mutable fixture controls
between parallel test runs. Use distinct Compose project names; the image tag
also includes that name, so separate checkouts cannot replace each other's image.

## Extending the suite

Keep driver expectations and upstream validation independent of broker helpers.
Add a scenario only when its real host, transport, or state-transition evidence
adds something beyond a focused test. For any failure case, assert where I/O
stopped; an OAuth error alone can pass for the wrong reason.
