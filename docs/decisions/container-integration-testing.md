# Container integration testing

## Status

Decision status: Accepted.

## Context

Fetch doubles cannot establish that built deployment artifacts, real host
listeners, DNS, TLS verification, streamed bodies, and independent upstream
services work together. The source offers Cloudflare Worker and Fastify adapters
around the same Token Exchange capability. Focused tests, public-package consumer
checks, and deployment checks retain their separate responsibilities.

The [experiment record](../research/container-integration-testing.md) records
primary sources and observations supporting this decision.

## Decision

Run one shared HTTP scenario suite against each host's built synthetic deployment.
Docker Compose owns containers, health checks, network, keys, and broker
startup. A Node driver on the host uses Docker CLI and native
HTTP requests. It needs no dependencies, Docker socket inside a container, custom
process supervisor, or broker lifecycle API.

Fastify's fixture bundles its compiled composition and broker implementation,
then `pnpm deploy --prod` creates an independent runtime directory with only
production dependencies. Worker artifacts come from `wrangler deploy --dry-run`;
Wrangler/Workerd runs their emitted JavaScript with `--no-bundle`. The Worker
fixture preserves the source compatibility date, flags, rate-limit binding,
mandatory observation semantics, required secrets, and named RPC export. Both hosts receive
credentials at startup; provider trust and issuance policy remain compiled into
the artifacts. Neither host replaces Fetch.

Separate OIDC and GitHub mocks use Node HTTP, HTTPS, and crypto. Each owns its
protocol and scenario controls; a small shared module owns transport, readiness,
bounded input, and sanitized evidence. OIDC signs synthetic ID Tokens. GitHub
independently verifies App JWT signatures, issuer, algorithm, and times, and
requires literal repository selection and Requested Permissions. Neither the
mocks nor driver import production request parsers, policy evaluators, or
response builders as their oracle.

Each Compose stack generates signing keys and a short-lived CA in a disposable
volume. Bridge-network aliases resolve the exact OIDC issuer and fixed GitHub
destination to the mocks. `NODE_EXTRA_CA_CERTS` configures broker trust while
retaining certificate and hostname verification. Both hosts must fail without
that CA. Dynamically assigned loopback ports expose the broker listener and
separate mock controls to the driver. The bridge permits outbound access; this
lane establishes fixture routing and protocol evidence, not egress isolation.

The driver recreates the broker container when a scenario requires fresh process
state and waits for its health check. Cold OIDC retrieval failures, absent CA
trust, the observation-failure artifact, body-limit cases, and cache/rotation
checks require separate lifetimes. Ordinary protocol cases share a broker, use non-cacheable
OIDC responses, reset the mock ledgers, and choose distinct Worker client IPs.
Resetting only mock responses cannot clear broker negative caches or refresh
cooldowns. Stateful scenarios deliberately keep one container and require both
absence of OIDC refetches and continued GitHub minting. Rotation uses the real
refresh cooldown.

Run each body-limit case with a fresh broker on both hosts. The pinned local
Wrangler/Miniflare proxy fails in a repeated known-length/chunked oversized-body
probe when the Worker rejects without consuming the body. A bare Worker reproduces the failure;
the broker is not required to trigger it. Separate lifetimes preserve the real
request-size assertions while keeping this lane's claim limited to rejection
from a fresh listener. They do not establish recovery after repeated oversized
requests or behavior at the production Cloudflare edge.

Separate compiled observation-failure artifacts exercise the existing adapter
seams. Fastify uses a synchronously failing logger stream; Worker uses its
observer interface. GitHub gates the authenticated revocation response so the
driver can require that exchange completion remains pending, then receives a
sanitized failure without a token. This enforces the
[mandatory observation decision](fail-closed-token-exchange-observability.md)
without claiming durable storage from default console logging.

Policy-denial scenarios require a new issuer-qualified mandatory observation
with the expected policy outcome, in addition to the public error and upstream
ledger. The driver reads complete JSON records through Docker Compose logs.
Fastify uses its native structured logger; the normal Worker fixture supplies a
JSON console observer through its existing runtime seam. This proves that the
request reached policy evaluation without replacing Fetch or adding a broker
control route, and makes no claim about production logging durability.

Use actual incomplete HTTPS bodies for deadline checks and chunked uploads for
request-size checks. Require the owning deadline with scheduling tolerance and
the expected upstream request sequence. Ledgers contain paths and validated
synthetic mint parameters, never authorization headers or signed tokens.

Local runs use explicit Compose startup, a Node test command against the prepared
stack, and explicit cleanup, as documented in the
[suite guide](../../test/integration/README.md). Run each host in its own Compose
project; distinct projects can run concurrently. Each project owns its image tag
and mutable state. The test command returns its result and leaves the stack for
inspection. Cleanup removes containers, network, and key volume. Image removal
is optional locally and included in CI; reusable build cache remains. No separate
local lifecycle wrapper is needed.

GitHub Actions has separate Fastify and Worker workflows with explicit fixture
startup, host-driver execution, failure logs, and `always()` cleanup. They share
the Compose file and Dockerfile with local runs. Each builds frozen dependencies
and artifacts from its checkout; no image publication or registry credentials
are needed. The test step stops surviving Docker command descendants before
cleanup through a Linux process group and shell traps. Both workflow results are
required by the aggregate CI check.

## Consequences

- This lane validates built synthetic compositions and protocol integration,
  not live GitHub grants, vendor issuance, external deployment inventory,
  Cloudflare edge routing, or distributed admission behavior.
- The local Worker binding is exercised. The fixture's client-IP header is test
  input and cannot establish production header provenance.
- Grouping compatible protocol cases reduces startup cost while separate
  lifetimes preserve cold-state and compiled-profile boundaries. Compose owns
  lifecycle and readiness. Exhaustive clock/cache combinations stay in focused tests.
- The host needs the pinned Node runtime and Docker Compose. Integration remains
  separate from `node --run check`, while CI requires both lanes.
- The existing production-consumer and named-entrypoint RPC checks retain their
  additional boundaries. Exporting the RPC entrypoint does not exercise a
  deployment-owned trusted service binding.

## Alternatives

- A custom host supervisor and control API duplicate container lifecycle
  management. Compose can start each real deployment command directly.
- Running Fastify from the development workspace or rebuilding Worker source at
  every startup weakens the deployment-artifact boundary.
- Cloudflare's current `createTestHarness` substitutes Node Fetch for Workerd
  outbound requests, bypassing the native TLS path this lane exercises.
- A containerized driver needs Docker access to recreate brokers; a host driver
  keeps Docker access on the host and reaches ports published only on loopback.
- Hiding CI in the local runner obscures workflow operations. Inline Compose
  heredocs duplicate the service definition; ordinary Compose YAML has one owner.
- Idle containers followed by `docker exec`, services waiting for checkout, or
  published fixture images add bootstrap or registry lifecycle work.
- Rewriting upstream URLs, injecting Fetch responses, or disabling TLS validation
  bypasses the network and trust boundaries under test.
- Direct Workerd configuration requires rate-binding emulation that Wrangler
  already supplies. Live upstreams require credentials and cannot reproducibly
  provide malformed documents, redirects, or stalled bodies.
