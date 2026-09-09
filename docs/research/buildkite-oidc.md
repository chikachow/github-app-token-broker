# Buildkite OIDC research

Research date: 2026-09-08. Public metadata and primary documentation were inspected;
no live Buildkite job token was minted. Synthetic integration tests establish
broker behavior, not live provider interoperability.

## Authentication contract

The [live Provider Configuration Document](https://agent.buildkite.com/.well-known/openid-configuration)
identifies `https://agent.buildkite.com` as the issuer, advertises `RS256`, and
delegates verification keys to `https://agent.buildkite.com/.well-known/jwks`.
This fits the broker's existing discovery trust path without a direct-key override.

The [agent OIDC reference](https://buildkite.com/docs/agent/cli/reference/oidc)
documents a configurable audience, a five-minute default lifetime, and a compound
default `sub` containing organization, pipeline, ref, commit, and step information.
`--subject-claim` can replace that subject with an immutable identifier. The broker
therefore treats `sub` as opaque instead of reconstructing or parsing it.
The [platform limits](https://buildkite.com/docs/platform/limits) separately list a
default maximum OIDC token lifetime of two hours: requesting 300 seconds is a
client choice, not evidence that every Buildkite token expires within five minutes.

## Claims for authorization

Buildkite's [agent reference](https://buildkite.com/docs/agent/cli/reference/oidc)
documents these relevant fields:

| Claims                               | Representation and use                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `organization_id`, `pipeline_id`     | Optional UUID strings; request with `--claim organization_id,pipeline_id` for the example policy. |
| `organization_slug`, `pipeline_slug` | Mutable names; the example does not use them as identity anchors.                                 |
| `build_branch`, `build_commit`       | Build branch and commit context.                                                                  |
| `step_key`                           | Step key; null when no key is set.                                                                |
| `build_tag`                          | Included only when a tag is set.                                                                  |
| `build_number`                       | Numeric; not selected by the example.                                                             |
| `build_source`, `runner_environment` | Trigger source and runner context; not selected by the example.                                   |

Buildkite recommends immutable identifiers for trust policies in its
[AWS guidance](https://buildkite.com/docs/pipelines/security/oidc/aws).
Exact UUID predicates avoid coupling authorization to mutable slugs. Optional
claim selection requests provider-owned values, not client-supplied claim values;
the [agent API source](https://github.com/buildkite/agent/blob/main/api/oidc.go)
and [CLI source](https://github.com/buildkite/agent/blob/main/clicommand/oidc_request_token.go)
show a job-associated token request with claim names. These source links track
upstream main and are not immutable snapshots of server-side authorization logic.

## Provenance limitation

The [GitHub integration](https://buildkite.com/docs/pipelines/source-control/github)
allows fork builds and optional fork-branch prefixing. [Branch configuration](https://buildkite.com/docs/pipelines/configure/workflows/branch-configuration)
documents that pull-request builds bypass pipeline-level branch filters.
The [build creation API](https://buildkite.com/docs/apis/rest-api/builds)
accepts branch and commit independently.

Consequently, a branch claim equal to `main` is not proof of trusted default-branch
code. Neither the documented claims nor inspected discovery metadata supply a
repository/fork/pull-request provenance claim sufficient to infer such a guarantee.
The `webhook` source alone does not distinguish a push from a pull request.

The example assumes a trusted pipeline: its editing, build creation, fork handling,
and agent execution are controlled outside the broker. Branch and step predicates
narrow the jobs authorized in that pipeline. Unselected source/tag fields impose
no additional restriction. GitHub target repository selection remains an explicit,
independent part of Token Issuance Policy and the exchange request.

## Design consequence

Use the existing OIDC Provider Registration and Claim Predicates, with a null ID
Token Profile. Missing selected contextual claims prevent policy applicability;
they do not establish a different token kind or require global authentication rules.
The [service contract](../service-contract.md#source-supported-buildkite-oidc-registration)
owns implemented behavior, and the [composition recipe](../../examples/buildkite/README.md)
owns composition and request usage instructions. The existing authentication and policy decisions apply
without amendment.
