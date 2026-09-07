# Implementation review — 2026-09-08

The origin review identified four actionable findings: JWK cache admission can publish unusable keys,
GitHub body failures lose a received status, unused GitHub error bodies retain
transport resources, and the property mutation comparison omits two ordinary
test projects. The findings below describe the pinned origin revision. The
existing module boundaries remain appropriate; these concerns can be corrected
locally without changing the composition or policy interfaces.

## Scope and evidence

This review covers the complete implementation at fetched `origin/main`,
[`0a73842685f062491e418b76f581b3a3adf99cfd`](https://github.com/chikachow/github-app-token-broker/tree/0a73842685f062491e418b76f581b3a3adf99cfd).
It includes OIDC/provider packages, GitHub issuance and RPC, Token Issuance
Policy, Token Exchange, both host adapters, HTTP helpers, package artifacts,
deployment checks, CI, and example/property tests. Independent reviews examined
contract fidelity and repository standards, followed by reproduction and
cross-checking of the material findings.

The user's checkout began at `591aaeaa679ca0214d196be3002567dd479739e8` with
three additional commits introducing container integration tests and required
CI lanes. The review used a separate checkout of the origin revision. Those
local commits are preserved; they do not change the runtime source implicated
below. Their integration work addresses the absence of that lane on the reviewed
origin snapshot and is not reported as a new defect.

P2 denotes a correctness issue to fix; P3 denotes a lower-priority robustness or
verification gap. No unauthorized token issuance was demonstrated.

## Spec

### P2: Admit only JWK Sets usable by the actual verifier

The [usability probe](https://github.com/chikachow/github-app-token-broker/blob/0a73842685f062491e418b76f581b3a3adf99cfd/packages/oidc/src/registered-provider-verifier.ts#L1037-L1041)
overrides `ext` with `true` before importing each JWK and treats an imported
public key as usable. JOSE's subsequent selector examines the original `ext`,
and its signature verifier imposes further cryptographic requirements. Admission
therefore accepts some sets that actual verification cannot use.

Node 24.18.0 public-authenticator probes using the repository's signed-token
fixtures established these cold-cache results:

| Provider key                                          | Cold result                                         |
| ----------------------------------------------------- | --------------------------------------------------- |
| Valid key, absent/boolean `ext`                       | Authenticates                                       |
| Same valid key with `ext: "invalid"`, `0`, or `null`  | Subject-token rejection, `ERR_JWKS_NO_MATCHING_KEY` |
| 1024-bit RSA public key with matching `kid` and `alg` | Internal failure with no diagnostic code            |

The warm probes first authenticated with the valid fixture JWK and
`Cache-Control: max-age=0`, advanced the injected clock by one second, then
returned either the `ext: "invalid"` key or the weak RSA key. Both replaced the
working generation and produced the same failures as their cold cases. Neither
emitted refresh-failure/stale-use diagnostics. A separate malformed `kty: 0`
control retained the working generation and authenticated with both diagnostics.
The weak-RSA case is also outside the
minimum key size required by [RFC 7518 section 3.3](https://www.rfc-editor.org/rfc/rfc7518.html#section-3.3).

This conflicts with the [OIDC decision's cache guarantee](../decisions/oidc-id-token-authentication.md#cache-identity-and-availability):
“Invalid refreshes never replace a last-known-good generation.” The service
contract classifies wholly unusable JWK Sets as provider unavailability. The
observed failures instead map to Client `400` or internal `500` and discard
eligible fallback state. They remain fail closed but unnecessarily interrupt
valid authentication during a malformed provider refresh.

Align cache admission with the selector and cryptographic admissibility used by
verification. Add public regressions for cold classification, preservation of
the previous generation, bounded fallback and diagnostics, and valid `ext: false`.
Keep this correction inside the OIDC boundary; splitting the cache state machine
or introducing another general validation abstraction is not required by the
finding.

### P2: Retain the received GitHub status on body transport failure

The [GitHub request catch](https://github.com/chikachow/github-app-token-broker/blob/0a73842685f062491e418b76f581b3a3adf99cfd/packages/github/src/http.ts#L172-L177)
converts body-read errors into `GitHubApiTransportError`, which has no received
status. [Issuance diagnostics](https://github.com/chikachow/github-app-token-broker/blob/0a73842685f062491e418b76f581b3a3adf99cfd/packages/github/src/app.ts#L179-L185)
then emit an undefined `upstreamStatus` even though response headers arrived.

A focused issuance probe resolved installation `12345`, received HTTP `201` for
the mint request, and then errored while consuming its body. Issuance correctly
returned `upstream_unavailable` and retained the installation ID, but lost the
received `201`. This conflicts with the
[failure-classification decision](../decisions/github-api-failure-classification.md#response-and-logging-boundary)
and the service contract's promise to record the actual upstream status when a
response was received. That distinction matters when investigating an ambiguous
issuance which GitHub may already have accepted.

Carry optional received status through sanitized transport failures. Preserve
the existing OAuth mapping and absence of raw exception details. Regressions
should distinguish failure before headers, failure after `201` headers, and a
deadline during body consumption, checking the final issuance observation.

## Standards

### P3: Release discarded GitHub response bodies promptly

[Status-only error classification](https://github.com/chikachow/github-app-token-broker/blob/0a73842685f062491e418b76f581b3a3adf99cfd/packages/github/src/http.ts#L164-L168)
throws without consuming or cancelling the body. The
[rate-limit classifier](https://github.com/chikachow/github-app-token-broker/blob/0a73842685f062491e418b76f581b3a3adf99cfd/packages/github/src/http.ts#L185-L197)
returns immediately for non-403 statuses and header-classified rate limits.
Consequently these terminal paths leave an unused response body attached to its
transport.

A native-Fetch Node 24.18.0 loopback probe returned the `503` error while the body
was unused and unlocked and the upstream response remained open. Explicit
cancellation closed the response promptly. The existing ten-second deadline
bounds retention for native Fetch, so this is not an unbounded-lifetime claim.
Repeated failures can nevertheless hold unnecessary resources throughout that
interval. [Undici recommends consuming or cancelling bodies](https://github.com/nodejs/undici#garbage-collection)
because abandoned bodies impair connection reuse and can exhaust connections.
This is a robustness issue under `AGENTS.md`'s requirement to own external-I/O
timeouts and response bounds.

Cancel bodies which no remaining path consumes, without waiting for arbitrary
upstream completion or changing failure classification. Verify status-only
failures, header-classified rate limits, and non-204 revocation responses. Keep
cleanup in the shared GitHub transport rather than duplicating it in issuance
and RPC callers.

### P3: Compare mutations against every ordinary test project

The [mutation manifest](https://github.com/chikachow/github-app-token-broker/blob/0a73842685f062491e418b76f581b3a3adf99cfd/scripts/property-mutations.mjs#L9)
defines its ordinary lane as only `unit` and `worker-integration`. Every mutant
inherits that lane; the runner converts it directly into Vitest project filters.
The `node` and `fastify` projects are omitted, contrary to the
[accepted testing decision](../decisions/property-based-testing.md#test-admission),
which requires “all non-property tests.”

The unmutated full-suite control includes these projects, but it cannot show
whether they kill an individual mutant. The Node project owns late-rejection and
revocation ordering checks, and Fastify owns host parsing and translation. None
of the current 19 curated mutants specifically targets their unique behaviors;
this review therefore does not claim an existing incorrect `property-unique`
classification.

Include all four ordinary projects, or select every discovered project except
`property`. Preserve the exact responsible-property lane and typechecked-mutant
requirement. Verify project selection and rerun the matrix after correcting it.

## Simplicity and maintainability

Preserve the runtime-neutral Token Exchange handler, independent provider trust
and positive Permit Statements, narrow host adapters, immutable Claims, and
GitHub-owned issuance/revocation capability. They keep security decisions in
modules that can enforce them. The built ESM/declaration and production-pruned
consumer checks provide useful independent boundaries.

The demonstrated simplification opportunity is eliminating disagreement between
JWK preflight and actual verification. Module size alone is not evidence that
the generation-aware OIDC cache should be split. Likewise, a general policy
language, host abstraction, or workflow framework would add maintenance without
resolving a finding here. Existing finite protocol tables and independent
property oracles should remain authoritative.

## Documentation corrections

This documentation handoff records the previously missing numeric OIDC response,
cache, stale and retry limits in the [service contract](../service-contract.md#oidc-remote-document-limits-and-caching).
It describes the current operation-time freshness calculation, including that it
does not account for `Age`, `Date`, or `Expires`; full HTTP-cache freshness
semantics were not established by this review.

The deployment and release documentation now distinguishes a production-pruned
consumer built from the current worktree from enforcement of tracked, clean
source provenance. Release callers own that source boundary. The implementation
reference distinguishes Worker console logging from Fastify request logging,
and the documentation index includes the accepted mandatory-observation decision.
These original documentation corrections do not change the service behavior or
resolve the implementation/verification findings by themselves.

## Origin review verification and boundaries

The following passed against the isolated origin snapshot with Node 24.18.0 and
pnpm 10.33.0:

```bash
fnm exec --using=24 corepack pnpm install --frozen-lockfile
fnm exec --using=24 corepack pnpm run check
fnm exec --using=24 corepack pnpm exec vitest run --coverage
```

`check` completed formatting, generated types, lint, build, artifact consumers,
typechecking, Knip, tests, production-pruned Node deployment verification, and
the Worker dry run. All 29 test files and 539 tests passed. Coverage met the
configured gates: 99.37% lines, 97.09% branches, 99.55% functions, and 99.29%
statements. LCOV contains 28 runtime source files, including the GitHub, OIDC,
and Worker implementation modules; the short console table does not list every
fully covered file. The focused probes above supply evidence
for gaps beyond those passing tests.

The full mutation matrix was not rerun during the origin review. The origin snapshot has no container
integration command, and the three additional local commits were not validated
as part of this origin review. No production composition, live vendor credentials,
deployed routes, or durable observation sink was tested. This is an implementation
review of the pinned origin source; it makes no deployment or release claim.

## Remediation — 2026-09-08

All four findings are addressed in the local changes based on
`591aaeaa679ca0214d196be3002567dd479739e8`, preserving the three integration
commits described above.

- OIDC cache admission uses JOSE's local resolver for each candidate key and
  accepted algorithm, removing the duplicate algorithm/material table and
  matcher. Admission and actual verification share public-key, verification-usage,
  and RSA minimum-size requirements. Non-boolean `ext` invalidates the response;
  valid `ext: false` remains accepted. Structurally valid mixed sets retain
  their complete membership, including unusable keys and duplicate ambiguity.
- GitHub transport failures retain the received status in sanitized issuance
  observations when body consumption fails. Failures before headers, including
  responses arriving after cancellation wins, do not invent upstream status.
- Unused GitHub bodies, including late responses, are cancelled without awaiting
  cleanup. Synchronous or asynchronous cleanup failures cannot alter the result.
  Required token revocation remains awaited, including its failure handling.
- The mutation manifest selects `!property`. Actual discovery confirms all 26
  ordinary test files across `unit`, `worker-integration`, `node`, and `fastify`,
  with the responsible-property selection unchanged.

Public regressions first reproduced the wrong cold/warm JWK classifications,
lost GitHub status, missing cancellation, cancellation replacing a selected
failure, and late-response retention. Controls cover the exact stale cutoff,
`no-cache`, `must-revalidate`, `no-store`, mixed-key selection and ambiguity,
all ten accepted signing algorithms, native Node connection closure, late
rejections, and pending revocation-response cleanup. A separate adversarial
review found no unresolved source or test findings after correcting the
selected-key documentation and tightening the integration timing oracle.

The following initial remediation checks passed with Node 24.18.0 and pnpm 10.33.0:

```bash
fnm exec --using=24 corepack pnpm run check
fnm exec --using=24 corepack pnpm exec vitest run --coverage
```

The full check includes built package consumers, production-pruned Node
deployment verification, and the Worker dry run. All 30 test files and 580
tests passed. Coverage met the configured gates: 99.29% lines, 97.23% branches,
99.56% functions, and 99.21% statements. These aggregate figures supplement the
failure-path regressions; they do not establish exhaustive correctness.

The initial remediation container run also passed:

```bash
fnm exec --using=24 corepack pnpm run test:integration
```

Fastify passed 37 tests and Workerd passed 38. Both hosts exercised real TLS
discovery/JWK retrieval and GitHub requests, including cold malformed `ext`,
last-known-good use after an actual malformed refresh, and prompt closure of
an unused GitHub error body. Compose removed its containers, volumes, networks,
and runtime images after the run.

The curated mutation command passed in a clean disposable snapshot:

```bash
fnm exec --using=24 corepack pnpm run test:mutations:property --format=json
```

The runner reported temporary snapshot commit
`7b052f8ba092893e24c8b6e9a919a7125563321e`, tree
`dfc534aff1d286e7e024ea2656a156cd0681fc0c`. All 149 non-Markdown source, test,
and configuration files were compared byte-for-byte with the initial remediation
worktree. The follow-up below changes that source snapshot. The disposable commit
does not change the user's checkout history.

The full unmutated control and every ordinary/responsible-property control
passed. All 19 mutants typechecked and were killed by their responsible
property. Sixteen were also killed by ordinary tests (`defence-in-depth`). The
three `property-unique` cases were `policy-ignore-issuer`,
`policy-accept-inherited-claims`, and `policy-cross-subject-contribution`.
There were no unsupported properties or surviving mutants in this curated
matrix; this is fault-sensitivity evidence, not an exhaustive mutation score.

Initial remediation formatting, local documentation links and anchors, and `git diff --check`
passed. At that stage, the changes were uncommitted and unpublished. Production compositions,
live vendor credentials, deployed routes, and durable observation delivery
remain outside this local verification.

## Final mergeability review follow-up — 2026-09-08

The subsequent adversarial review identified two further findings, now addressed:

- **P2, Spec:** A valid, bounded JWK Set containing deeply nested additive JSON
  could make JOSE's resolver construction throw `ERR_JWKS_INVALID` outside key
  admission's catch, producing an internal failure. The existing JWK refresh
  boundary now normalizes that error to `ERR_OIDC_JWKS_INVALID`. Both singleton
  admission and complete-set construction follow provider-unavailable handling,
  including the existing stale-cache and retry rules. Other unexpected errors
  retain their classification.
- **P3, Standards:** The unused GitHub error-body integration scenario checked
  response classification and body closure without proving the complete request
  boundary. It now requires exactly one installation lookup GET and zero token
  mint events.

The public authenticator regression first reproduced the P2 classification
failure. Five cases now cover wholly incompatible keys, both mixed-key orders,
eligible stale fallback, and `no-cache` rejection through failure backoff. All
106 tests in the registered-verifier file passed. Both container hosts also
exercise the deeply nested JSON through real TLS retrieval and require HTTP
503, `temporarily_unavailable`, the expected discovery/JWK request sequence, and
no GitHub requests. Fastify passed 38 tests and Workerd passed 39; Compose cleanup
completed successfully.

A distinct read-only adversarial review found no unresolved follow-up findings.
Its independent Node probes covered mixed-key ordering, concurrent refresh
coalescing, one refresh-failure diagnostic, cache restrictions, retry recovery,
fresh-cache unknown keys, and unchanged errors outside the refresh boundary.

Two runs of the default full check reached the test suite but timed out in the
unchanged Token Exchange form property at its 10-second budget. No counterexample
was reported. Exact seed replays (`-1568327133` and `-769563293`) each passed all
750 cases in isolation, taking 0.924 and 0.888 seconds respectively. Neither the
property budget nor its timeout was changed.

The complete check and coverage then passed with Vitest's worker count limited
to two for this invocation:

```bash
VITEST_MAX_WORKERS=2 fnm exec --using=24 corepack pnpm run check
VITEST_MAX_WORKERS=2 fnm exec --using=24 corepack pnpm exec vitest run --coverage
fnm exec --using=24 corepack pnpm run test:integration
```

All 30 files and 585 tests passed, including all property cases. The complete
check also passed the built package consumers, production-pruned Node deployment
verification, and Worker dry run. Coverage met the existing gates: 99.29% lines,
97.24% branches, 99.56% functions, and 99.22% statements. The passing isolated
replays and reduced-concurrency run support scheduling pressure as the timeout
cause; the default-concurrency runs themselves did not pass. No permanent
runner configuration or test-budget change was introduced.

The 19-mutant result above remains evidence for its recorded initial-remediation
snapshot. It was not rerun for this follow-up, which changes no curated mutation
target or property oracle; the new failure boundary is covered by the public
regressions and both container hosts. Final formatting, local documentation
links, and diff checks passed. At that stage, all changes were uncommitted and unpublished.

## Pull request preparation — 2026-09-08

The remediation is prepared as a follow-up to [container integration PR #67](https://github.com/chikachow/github-app-token-broker/pull/67), based on its head
`78c5a9f3bdf1a2e9ab7ecdabba94b412066beffe`. That harness supersedes the three
checkout commits used for the initial local validation. The runtime fixes and
public regressions are unchanged; integration scenarios are ported to its
separate OIDC and GitHub mocks and Compose-owned host recreation. The older
combined upstream mock and host lifecycle implementation are not reintroduced.

The commit sequence separates OIDC admission and classification, GitHub
transport status and cleanup, and mutation comparison with documentation.
Earlier measurements above remain tied to their recorded snapshots.
