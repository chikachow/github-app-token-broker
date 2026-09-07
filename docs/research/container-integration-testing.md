# Container integration testing findings

Primary-source research and local experiments, updated 2026-09-08. The
[accepted decision](../decisions/container-integration-testing.md) owns the
architecture; the [suite guide](../../test/integration/README.md) owns commands
and scenario guidance.

## Deployment and transport boundary

The lane executes built synthetic deployments against independent HTTPS OIDC and
GitHub mocks. The production GitHub destination remains `https://api.github.com`;
a Compose DNS alias routes it to a mock with a hostname-valid certificate. The
OIDC issuer uses the same arrangement. Native Fetch, generated signing keys,
and a broker-only test CA preserve the actual authentication and transport path.
The [service contract](../service-contract.md) remains authoritative for errors,
limits, trust, and authorization.

Fastify's integration fixture bundles the compiled composition and workspace
broker packages, then uses `pnpm deploy --prod` to create `/fastify`. Inspection
of emitted JavaScript found only Node built-ins and `fastify` as external imports.
A separate local production deployment resolved Fastify within its own dependency
tree and contained no source, TypeScript, or bundler fallback. The existing
package-root production-consumer check separately validates public exports and
declarations. [pnpm deployment documentation](https://pnpm.io/cli/deploy)
describes the independent deployment directory.

Worker fixtures build through explicit `wrangler deploy --dry-run` commands in
the Dockerfile. Compose starts the emitted JavaScript with
`wrangler dev --no-bundle`. Both commands use the source Wrangler configuration,
retaining its compatibility settings, rate-limit binding, observation settings,
and required secret declaration. Disposable App credentials are supplied
separately at runtime. The fixture retains the named RPC export. The lane
exercises the HTTP adapter; the separate named-entrypoint test retains the trusted
service-binding boundary.

## Worker native HTTPS

The initial inspection found Wrangler `4.127.0` implements `createTestHarness()` with an
`outboundService` that calls `globalThis.fetch` in Node. Although the API consumes
build output, that substitution would bypass Workerd's native outbound TLS path.
The suite therefore uses the Wrangler CLI with emitted output and `--no-bundle`.
Cloudflare documents the API in its
[integration test harness guide](https://developers.cloudflare.com/workers/testing/test-harness/).

The same inspection found Miniflare `5.20260826.0-alpha` reads `NODE_EXTRA_CA_CERTS` and adds its
certificates to Workerd's internet-service TLS options. Node reads the same
variable at startup. Full container experiments confirmed successful HTTPS for
both hosts with the test CA and failure before upstream HTTP requests without it.
([Miniflare core source](https://github.com/cloudflare/workers-sdk/blob/main/packages/miniflare/src/plugins/core/index.ts),
[Node 24 CA configuration](https://nodejs.org/docs/latest-v24.x/api/cli.html#node_extra_ca_certsfile))

Direct Workerd supports sockets, ES module bundles, outbound networks, and trusted
CAs, but the inspected `1.20260826.1` configuration schema has no native rate-limit
binding field. Wrangler supplies the local binding emulation required here.
`global_fetch_strictly_public` remains enabled; its meaning concerns Cloudflare
own-zone routing, not local test CA configuration.
([versioned Workerd schema](https://github.com/cloudflare/workerd/blob/v1.20260826.1/src/workerd/server/workerd.capnp),
[compatibility flag definition](https://github.com/cloudflare/workerd/blob/v1.20260826.1/src/workerd/io/compatibility-date.capnp))

## Compose

One Compose file owns service commands, build, health checks, network, and generated
keys. The host Node driver recreates the broker container when a scenario needs
fresh process state and discovers its loopback port. This removes a custom
supervisor and reset API while clearing broker caches and admission state at
the boundaries that need it. Ordinary protocol cases share a broker and use
non-cacheable OIDC responses. Cold OIDC failures, absent CA trust, and
each body-limit case and cache/rotation checks retain separate broker lifetimes. The scenario structure uses eleven starts per host.
The cache/rotation scenario intentionally retains one container
throughout its transitions. Compose documents
[health-based startup ordering](https://docs.docker.com/compose/how-tos/startup-order/).

A probe alternating known-length and chunked oversized bodies exposed a local
forwarding failure with Wrangler `4.129.1` and Miniflare `5.20260907.0-alpha`.
A bare Worker returning `413` without consuming the body produced twelve expected
responses and twelve `500 Network connection lost` responses across 24 requests.
The installed Miniflare entry worker catches this error from `service.fetch(request)`
and creates the `500` response. Adding `await request.arrayBuffer()` before the
bare Worker's rejection produced 24 expected responses in the same probe. The
suite therefore runs its unchanged known-length and chunked body-limit assertions
against separate fresh brokers on both hosts, requiring rejection before upstream
I/O. This establishes the boundary of this local probe; it does not establish
recovery after repeated oversized requests or behavior at the production
Cloudflare edge.

Each run uses a project-specific image tag and independent mutable fixtures.
An interleaved two-project experiment reproduced artifact replacement under one
shared tag; project-specific tags kept each artifact independent and allowed
cleanup of one project while the other continued.
([project-name interpolation](https://docs.docker.com/reference/compose-file/version-and-name/),
[Compose cleanup](https://docs.docker.com/reference/cli/docker/compose/down/))

OrbStack provides the local Docker engine and Compose implementation. A direct
port-publication probe on this machine found that an internal network produced
no usable published port; a standard bridge returned HTTP `200`. The implemented
bridge binds dynamic broker/control ports to `127.0.0.1` and permits outbound
traffic. It does not provide egress denial.
([OrbStack Docker documentation](https://docs.orbstack.dev/docker/))

## Protocol oracles and observed results

The mocks use Node HTTP, HTTPS, and crypto, with no production parser, policy, or
response-builder imports. GitHub verifies App JWT signatures, issuer, algorithm,
and validity times, then requires literal repository and permission narrowing.
These inputs follow GitHub's
[installation-token endpoint](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app).
Every protocol case checks both the public outcome and material upstream requests.
Failure ledgers omit assertion text, authorization headers, and signed tokens.

| Boundary                    | Observed evidence                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Signing and least privilege | Successful exchange required genuine RS256 ID Tokens, App JWT verification, and exact repository/permission mint parameters.                                                   |
| TLS trust                   | Removing the CA from a fresh broker caused `503` before any upstream HTTP request on both hosts.                                                                               |
| Body limits                 | Fresh real listeners rejected known-length and chunked bodies above 64 KiB before upstream I/O; repeated oversized-request recovery is not established.                        |
| Complete-response deadlines | Incomplete OIDC/GitHub HTTPS bodies produced failures at their owning five-/ten-second deadlines and reached the expected upstream stage.                                      |
| Cache and rotation          | A subsequent exchange avoided OIDC fetches but minted a new token. Unknown-key refresh was suppressed during the cooldown; after 10.1 seconds one JWKS fetch enabled issuance. |
| Local Worker admission      | Thirty requests from one fixture IP were admitted, the next received `429`, and a different IP remained admissible.                                                            |

Earlier sensitivity experiments modified only disposable built artifacts. Changing
mint `contents` from `read` to `write` made both hosts' positive issuance checks
fail at the independent GitHub oracle. Raising the JWKS limit from 256 KiB to
2 MiB exposed a weak original fixture containing only padding. The retained
fixtures include valid signing keys: 32 KiB padding succeeds, while 1 MiB fails
under the production limit and detects the weakened bound. These experiments
establish sensitivity to those faults, not an exhaustive mutation score.

The source behavior was preserved. Two initial experiment expectations were
corrected to match the contract: unusable JWKS is `503`, distinct from invalid
Provider Configuration metadata (`400`); rejected GitHub redirects follow the
otherwise unclassified `500` mapping.

The lane does not establish live provider issuance, GitHub installation grants,
deployment-owned composition or credentials, Cloudflare edge routing, distributed
admission, production header provenance, or durable console logging. Deadline
checks also do not establish immediate cancellation of every remote socket.
