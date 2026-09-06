# Container integration testing findings

Research findings checked on 2026-09-06 against repository source and primary
vendor documentation. The [accepted decision](../decisions/container-integration-testing.md)
and [suite guide](../../test/integration/README.md) describe the implemented pattern.
The experiment record distinguishes observations from source-supported feasibility.

## Recommended boundary

Run an independently driven HTTP exchange against each real host, with an OIDC
Provider and GitHub API fixture reached through actual HTTPS sockets in other
containers. Use generated signing keys, a generated test CA, and a build-time
fixture composition. Keep the production GitHub destination fixed at
`https://api.github.com`: a container-network DNS alias routes that hostname to
the fixture, whose certificate includes the hostname. The OIDC registration
similarly names an exact fixture HTTPS issuer. Trust the test CA only in the
test processes. This recommendation preserves the boundaries owned by the
[service contract](../service-contract.md) and [security policy](../../SECURITY.md).

The existing `worker-integration` Vitest project executes a real named Workerd
entrypoint, but `vitest.config.ts` supplies an `outboundService` function that
constructs responses in the test host. The Fastify deployment fixture exercises
a real listener with a deny-all composition. Both checks remain useful, but
neither proves a successful exchange across independently running OIDC and
GitHub servers. The new lane should complement their focused coverage.

Do not import broker request builders, policy evaluation helpers, or response
fixtures into the independent servers or HTTP driver. The GitHub fixture should
verify the App JWT signature with the generated public key and check its issuer
and time claims before responding. It should reject a mint request unless its
repository selection and permissions match the scenario's literal expectation.
An otherwise successful exchange must therefore fail if the broker broadens
permissions or authenticates GitHub requests incorrectly. GitHub documents App
JWT authentication and narrowing through `repositories`, `repository_ids`, and
`permissions` in its
[installation-token endpoint](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app).

## Runtime and orchestration choices

OrbStack already provides a Docker engine and Compose support, so use ordinary
`docker compose` commands. Apple Container would add another orchestration path
without serving the requested Compose-to-Actions parity.
([OrbStack Docker documentation](https://docs.orbstack.dev/docker/))

Compose supports waiting for declared health checks with
`depends_on: condition: service_healthy`; container startup alone does not mean
the service accepts requests. Use bounded HTTP readiness checks, a test-runner
exit code, and cleanup that removes only the test project's containers,
networks, volumes, and project-scoped image.
([Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/))

GitHub Actions service containers require Linux runners. The runner creates a
fresh container network and cleans services up after each job. Container jobs
reach services by their service labels; host jobs reach published ports on
loopback. The service `image` must already exist in a registry, and the Actions
runner initializes containers before ordinary job steps. Consequently, a
same-job Docker build cannot supply a declarative service image.
([Actions service networking](https://docs.github.com/en/actions/tutorials/use-containerized-services/use-docker-service-containers),
[service syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idservices),
[runner initialization source](https://github.com/actions/runner/blob/main/src/Runner.Worker/JobExtension.cs))

For a pull-request lane without registry publication, start pinned public Node
service images, then copy the current checkout's built fixture artifacts into
those containers and start their processes after dependency installation and
build. Perform application readiness checks after that bootstrap; a service
health check that needs checkout files would block initialization before the
checkout step can execute. The alternative is publishing images in a preceding
job, which adds registry authorization and image lifecycle ownership. This
bootstrap recommendation is an inference from the documented service lifecycle,
not a claim that Actions builds services from source.

Use the same fixture launch commands and artifact layout in Compose and CI.
Pass the Actions-owned container IDs and network name to bootstrap code rather
than discovering unrelated containers by partial names. Capture bounded logs on
failure and inspect process exit state so startup failures do not become opaque
request timeouts.

## Workers HTTPS feasibility

The current Miniflare source reads `NODE_EXTRA_CA_CERTS` and forwards its PEM
certificates to Workerd's internet service TLS options. Node also reads that
environment variable at process startup. This gives Wrangler and native Node
Fetch a common test-only trust configuration without replacing Fetch or
disabling certificate validation. Inspection of the installed, lockfile-selected
Miniflare `5.20260826.0-alpha` confirms both the environment-variable loading and
the Workerd TLS configuration; the subsequent network experiments below confirm this path.
([Miniflare core source](https://github.com/cloudflare/workers-sdk/blob/main/packages/miniflare/src/plugins/core/index.ts),
[Node 24 CA configuration](https://nodejs.org/docs/latest-v24.x/api/cli.html#node_extra_ca_certsfile))

Cloudflare documents `createTestHarness()` as an integration API that runs
production build output, supports multiple Workers, exposes bindings, and
captures runtime logs. Installed Wrangler `4.127.0` exports this API and its
`listen()` method. It is worth comparing with a `wrangler dev` process. A container lane should drive a real
HTTP socket whichever launcher is chosen.
([Cloudflare integration test harness](https://developers.cloudflare.com/workers/testing/test-harness/))

Direct Workerd is also feasible at the configuration level: the locked
`1.20260826.1` schema supports ES module bundles, text bindings, listening
sockets, `globalOutbound`, private-network allowlists, and explicit trusted CA
certificates. Its configuration is served with `workerd serve config.capnp`.
However, that schema has no native rate-limit binding field. A custom Workerd
configuration would need additional binding emulation, making Wrangler or
Miniflare preferable for exercising the repository's actual local Cloudflare
adapter.
([versioned Workerd schema](https://github.com/cloudflare/workerd/blob/v1.20260826.1/src/workerd/server/workerd.capnp),
[Workerd invocation](https://github.com/cloudflare/workerd/blob/main/README.md#running-workerd))

Preserve `global_fetch_strictly_public`. Its documented source meaning concerns
Cloudflare's own-zone origin routing; it is not a directive to replace local
test-network trust configuration.
([versioned compatibility flag definition](https://github.com/cloudflare/workerd/blob/v1.20260826.1/src/workerd/io/compatibility-date.capnp))

## Scenarios with useful independent oracles

These priorities derive from the
[request flow and host boundaries](../implementation.md),
[OIDC authentication decision](../decisions/oidc-id-token-authentication.md), and
[mandatory observation decision](../decisions/fail-closed-token-exchange-observability.md).

| Scenario                                            | Evidence the container lane should require                                                                                                                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Successful exchange on both hosts                   | Genuine RS256 Subject Token; HTTPS discovery and JWKS retrieval; GitHub fixture verifies App JWT; exact repository and permission body; opaque token and exact scope in the public response.                                                     |
| Invalid signature, audience, or unregistered issuer | Stable OAuth failure and zero GitHub requests; unregistered issuer causes no OIDC network request.                                                                                                                                               |
| Policy denial                                       | Independently valid ID Token, unsupported permission or target, and zero installation resolution or mint requests.                                                                                                                               |
| Installation owner mismatch                         | Resolution occurs, owner validation fails, and the fixture observes no mint request.                                                                                                                                                             |
| GitHub redirect                                     | A reachable redirect trap records zero requests and the broker returns its documented classified failure.                                                                                                                                        |
| OIDC redirect or invalid discovery identity         | Authentication fails without reaching a redirect trap or GitHub. Use an uncached registration/process to avoid a cache hiding the path.                                                                                                          |
| Delayed headers or stalled body                     | Server sends an intentionally incomplete exchange; measure the real five-second OIDC or ten-second GitHub deadline with scheduling tolerance, and verify no token escapes.                                                                       |
| Oversized streamed response                         | Send actual chunks without a reassuring Content-Length; require bounded public failure and no subsequent mint.                                                                                                                                   |
| Cache reuse and concurrent authentication           | Independent server counters show repeated exchanges reuse discovery/JWKS; coordinate cold concurrent requests to examine shared refresh behavior. Do not infer caching from response success alone.                                              |
| Mandatory post-mint observation failure             | A fixture-only observer rejects acknowledgement; GitHub sees one authenticated revocation before a sanitized failure response reaches the Client. This adds a deployment observer seam, so distinguish it from default console-adapter coverage. |
| Host-specific behavior                              | Fastify receives duplicate headers and raw form bytes over TCP; Worker admission rejects before OIDC/GitHub I/O. Keep Node transport rejection separate from adapter OAuth guarantees.                                                           |

Start with successful issuance, authorization denial, owner mismatch, redirects,
and complete-body deadlines. These exercise material transport and authority
boundaries and yield direct fixture-side evidence. Cache-expiry and key-rotation
experiments need care: the existing verifier owns freshness and unknown-key
refresh cooldowns, so wall-clock sleeps can lengthen the lane substantially.
Keep exhaustive clock-driven combinations in focused tests; admit container
variants when real scheduling or transport behavior is the hypothesis.

## Experiment record and limits

Experiments ran on OrbStack Docker Engine 29.4.0, Compose 5.1.2, Linux ARM64,
with the digest-pinned Node 24.18.0 image and the frozen repository dependencies.
Wrangler was 4.127.0 and its Workerd was 1.20260826.1.

| Experiment                                           | Observation and resulting choice                                                                                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default host processes with native Fetch and test CA | Both hosts completed signed issuance across separate HTTPS OIDC and GitHub containers. No Fetch injection or GitHub origin override was necessary.                                                                  |
| OIDC failures with only upstream state reset         | The first failure populated the broker's ten-second retry backoff; subsequent scenarios made no new OIDC request. Restart actual host processes between independent cases.                                          |
| Cacheable JWKS followed immediately by a rotated key | Both hosts correctly rejected the unknown key during their ten-second refresh cooldown. The permanent scenario checks suppression, then waits 10.1 seconds and requires one JWKS refresh and successful issuance.   |
| CA removed from fresh host child processes           | Both hosts returned `503` before any upstream HTTP request; the equivalent trusted configuration succeeded. This tests the TLS verification boundary itself.                                                        |
| Incomplete OIDC and GitHub HTTPS bodies              | Public failures occurred at the owning five-second and ten-second deadlines, with the expected upstream stage reached. The tests retain scheduling tolerance and do not claim immediate remote-socket cancellation. |
| Known-length and chunked request bodies              | Both real listeners rejected bodies exceeding 64 KiB before upstream I/O.                                                                                                                                           |
| Worker admission                                     | Thirty requests from one fixture IP were admitted, the next received `429`, and a different IP remained admissible. This establishes local binding behavior only.                                                   |
| Local Compose run                                    | All 59 baseline scenarios passed in 88.9 seconds, excluding image build and cleanup. The runner propagated earlier experimental failures and removed its project containers and key volume.                         |

A sensitivity experiment modified only a disposable built Token Exchange
artifact, broadening mint `contents` from the requested `read` to `write`. The
positive issuance case failed for both hosts (two failures), and the independent
GitHub fixture recorded the violation at the access-token mint endpoint. The
source worktree and package artifacts used by normal source validation were not
modified. This demonstrates sensitivity to that fault, not an exhaustive
mutation score.

A deliberate SIGINT while the Compose tests were running returned nonzero and
left no containers, networks, or generated-key volumes bearing that run's Compose
project label. The complete `node --run check` also passed, including all 539
existing tests, built-artifact checks, the production-pruned Fastify consumer,
and Worker deployment dry run.

Two initial test expectations were corrected against the existing contract:
unusable JWKS material is `503`, distinct from invalid Provider Configuration
metadata (`400`); GitHub redirects are rejected and follow the otherwise
unclassified `500` mapping. Neither experiment required changing production
behavior. Independent review also replaced an incomplete malformed-percent form
with a complete exchange containing a duplicate required parameter, and required
fresh GitHub minting during OIDC-cache reuse to avoid a token-cache false positive.

The fixtures establish protocol and host integration. They do not establish real
GitHub App installation grants, live vendor OIDC issuance, Cloudflare edge routing,
distributed rate limits, a deployment-owned RPC binding, or durable console
logging. These local experiments do not constitute a hosted Actions run.

## Harness isolation and oracle checks

An interleaved two-project build reproduced the shared-image failure: after
building A then B under one image tag, project A executed B's artifact. With
`${COMPOSE_PROJECT_NAME}-runtime`, each project executed its own artifact.
Cleaning A with `down --volumes --remove-orphans --rmi all` removed A's image;
B still ran successfully. Cleaning B then removed its image as well. Compose
exposes the selected project name for interpolation, and `down --rmi all`
removes the service images.
([project-name interpolation](https://docs.docker.com/reference/compose-file/version-and-name/),
[Compose cleanup](https://docs.docker.com/reference/cli/docker/compose/down/))

The original oversized JWKS contained only padding and could fail schema
validation even without the size bound. Increasing the disposable built
verifier's limit from 256 KiB to 2 MiB left both original scenarios green.
Adding a valid signing key made both scenarios detect the weakened boundary:
the mutated hosts issued tokens instead of returning `503`. With the production
limit, both hosts accepted a valid JWKS with 32 KiB of additive padding and
rejected the same structure with 1 MiB of padding. The suite retains both sizes
as independent literal fixtures; malformed-JWKS rejection remains a separate case.

## Independent host execution

The shared HTTP driver now selects one host per invocation. Concurrent local
Fastify and Worker runs passed all 30 and 31 harness scenarios respectively,
using different Compose projects, images, upstream fixtures, and key volumes.
Each project started only its selected host and removed its own resources.
The final rotation phase now also requires fresh GitHub installation resolution
and token minting, matching the evidence required during ordinary cache reuse.

A process-lifecycle experiment reproduced a supervisor race: the launcher exited
on SIGTERM while a descendant retained the listener, cancelling the old delayed
SIGKILL. The supervisor now waits for its entire process group, including when
the launcher has already exited, and escalates after a bounded grace period.
Real Node 24 listener experiments covered ordinary shutdown and a descendant
ignoring SIGTERM, with both live and already-exited launchers. All four released
the listener and removed the process group; ordinary shutdown took about 12 ms
and forced shutdown about five seconds. Both full Linux host runs also passed
with the revised supervisor.
