# Container integration testing

## Status

Decision status: Accepted.

## Context

Fetch doubles establish broker behavior but cannot establish that the real host,
DNS resolution, TLS verification, request encoding, response streams, and
independently running upstream services work together. The source offers both a
Cloudflare Worker adapter and a Fastify adapter around the same Token Exchange
capability. The existing focused tests, built-artifact checks, and deployment
checks retain their separate responsibilities.

The [experiment record](../research/container-integration-testing.md) documents
vendor guidance, pinned-source inspection, and local observations supporting
this decision.

## Decision

Run one shared, externally driven HTTP scenario suite once per actual host.
Each invocation selects Fastify or Wrangler/Workerd and owns separate HTTPS OIDC
and GitHub fixtures, signing keys, and host state. Use Docker Compose locally;
the default command runs both hosts sequentially in distinct projects, while
explicit host selections can run concurrently.
GitHub Actions uses separate Fastify and Worker workflows with named Compose
startup, test-result, logging, and cleanup steps. Both workflows use the same
`test/integration/compose.yml` service definition as local runs. Either host
failure leaves the other's evidence available, and both results are required
by the aggregate CI check.
No live credentials or deployment inventory participate.

The fixture composition imports public package roots. Fastify consumes built
JavaScript; Wrangler compiles the Worker composition and inherits the source
Worker's compatibility date, flags, and rate-limit binding. Neither composition
replaces Fetch. Each run generates disposable signing keys and a short-lived CA.
Private-network DNS aliases resolve the configured OIDC issuer and fixed
`api.github.com` destination to the fixture services. `NODE_EXTRA_CA_CERTS`
configures test-process trust without disabling certificate or hostname
verification. Tests explicitly require both hosts to fail without that CA.

The OIDC fixture signs ID Tokens with Node crypto. The GitHub fixture uses Node
crypto to verify App JWT signatures, issuer, algorithm, and times; it requires a
literal repository selector and Requested Permissions. The driver and fixtures
never import production request parsers, policy evaluators, or response builders
as their oracle. Fixture request ledgers contain paths and synthetic mint
parameters, never authorization headers or signed tokens. Every scenario checks
both the public outcome and the material upstream requests that did or did not
occur.

Each independent scenario starts a fresh host process. A fixture-only supervisor
owns restart and readiness on a separate control socket, waiting for the entire
child process group to exit with bounded TERM/KILL deadlines; it adds no broker route
or production reset hook. Shutdown is terminal: it prevents new starts and
waits for an active reset to cancel before stopping the remaining process group.
This is required because resetting upstream responses
does not clear the broker's negative caches or refresh cooldowns. Stateful cache
scenarios intentionally retain one process and prove both the absence of OIDC
refetches and continued GitHub token minting. Rotation checks observe the real
refresh cooldown rather than injecting a clock or changing cache policy.

A separate fixture composition deliberately fails post-mint observation. Fastify
uses a synchronously failing logger stream; the Worker uses its existing observer
interface. The GitHub fixture holds the revocation response open, allowing the
driver to require that the token response remains pending until revocation is
released, followed by sanitized failure with no token. This tests the
[mandatory observation decision](fail-closed-token-exchange-observability.md); it
does not claim that the default console logger provides durable storage.

Use actual incomplete HTTPS bodies for deadline tests and actual chunked uploads
for request-size tests. Measure the owning timeout with scheduling tolerance and
require the expected request sequence. These checks do not claim that returning
a timeout necessarily terminates every remote socket immediately.

Each CI job checks out source, then Compose builds the fixture image with frozen
Linux dependencies and public packages. Service dependencies order startup after
successful key preparation. Containers run their declared service commands
directly. Named workflow steps wait for the test container's exit status and
collect logs; an `always()` step removes the stack. No image publication or
registry credentials are needed.

The service declaration, Dockerfile, fixture programs, and scenarios are shared
with local runs. Workflow lifecycle commands remain explicit, while Compose
configuration has one owner in its own YAML file.

The Compose runner builds an image tagged with its Compose project name,
runs on an internal network, propagates the test exit code, and removes its own
image, containers, and generated-key volume on completion or interruption.
Docker's reusable build cache remains.

## Consequences

- This lane proves protocol integration with isolated upstream services, not
  live GitHub grants, provider token issuance, Cloudflare edge routing, or
  distributed Cloudflare rate-limit behavior.
- The local Worker binding is exercised, but the fixture's client-IP header is
  test input, not evidence about Cloudflare's production header provenance.
- The lane uses real time for network deadlines and one bounded key-rotation
  cooldown. Exhaustive cache/time combinations remain in focused tests.
- Integration runs separately from `node --run check` so ordinary source checks
  do not acquire a Docker prerequisite. CI requires both lanes.
- The existing named-entrypoint RPC test and production-consumer checks remain
  authoritative for their additional boundaries; this suite does not claim
  coverage of a deployment-owned trusted service binding.

## Rejected alternatives

- Delegating CI lifecycle commands to the local runner: hides the operational
  steps from the workflow.
- Embedding Compose YAML in a workflow heredoc: duplicates the service definition
  and makes both YAML documents harder to read.
- Per-container `docker run` steps: make startup dependencies, network ownership,
  and cleanup imperative. Compose expresses these declaratively.
- Idle Actions service containers followed by `docker exec` bootstrap: separates
  container startup from the actual service commands.
- Native upstream-image services waiting for checkout and dependency readiness:
  adds cross-step startup coordination before the services can run.
- Publishing fixture images for native Actions `services:`: adds registry
  credentials and image lifecycle work when each job can build its checkout locally.

- Rewriting GitHub URLs or injecting Fetch responses: bypasses the network and
  fixed-origin boundary this lane is intended to exercise.
- Disabling TLS verification: can make an insecure transport indistinguishable
  from a working integration.
- Waiting out negative-cache backoff between unrelated scenarios: adds time and
  order dependence without exercising a useful state transition.
- Direct Workerd configuration: requires additional rate-binding emulation that
  Wrangler already provides under the package's compatibility configuration.
- Live upstreams in pull-request CI: requires credentials and external state and
  cannot reproducibly supply redirects, malformed documents, or stalled bodies.
