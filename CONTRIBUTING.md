# Contributing

Keep changes cohesive, explicit, and grounded in the service contract.
[AGENTS.md](AGENTS.md) owns repository agent guidance; this document owns
validation scope and contribution requirements. Keep repository guidance
self-contained for contributors; personal agent configuration is not a
prerequisite. Command definitions and tool versions remain authoritative in `package.json` and the lockfile.

See [dependency tooling](#dependency-tooling) for the dependency update policy
and validation gates.

## Validation scope

Choose checks by the affected behavior. During implementation, use focused
checks; before opening or updating a pull request, apply the matching gate:

| Change                                                                         | Required verification                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent instructions or prose only                                               | Review instruction consistency, local links and fragments, documented commands against their scripts, and the final diff and status (including new files). Check changed Markdown files with the pinned formatter (`pnpm exec oxfmt --check <files>`) and run `git diff --check`. A full install and application check are not required solely for prose changes. |
| Code, configuration, dependencies, generated artifacts, or executable examples | Run `pnpm install --frozen-lockfile`, `node --run check`, and the [container integration suite](test/integration/README.md) for both Fastify and Worker. Follow its explicit Compose startup, test, and cleanup steps; both hosts remain required CI lanes. Add focused checks needed to establish the changed behavior.                                          |

For runtime, artifact, consumer, or deployment validation, read
[Implementation: Validation](docs/implementation.md#validation) and cover every
affected lane.
Once appropriate checks pass, broaden or repeat them only for new changes,
failures, or unresolved concerns. Report the exact command and blocker for any
check that cannot run; distinguish passed, skipped, and failed checks. Local
verification does not establish remote CI success or waive required CI checks.

If a required check remains unavailable after plausible scoped recovery attempts,
finish all independent work. A pull request already requested by the user may be
opened or updated as a draft, recording the exact command, blocker, and consequence
for confidence. Fixable implementation defects remain the author's work; a draft
is not a merge-ready handoff and does not waive the missing gate. This exception
does not authorize publishing an unrequested pull request.

## Documentation ownership

Before handoff, update the authoritative document for each affected concern:

- [Service contract](docs/service-contract.md) for externally observable behaviour.
- [Implementation](docs/implementation.md) for package layout, entrypoints, request flow, bindings, or validation lanes.
- [Deployment](docs/deployment.md) for source/deployment ownership and the relevant decision record for consumer migrations.
- [Publishing source artifacts](#publishing-source-artifacts) for publish-readiness requirements.
- [CONTEXT.md](CONTEXT.md) for a project-defined term or its meaning.

Publishing and tagging releases still require [Publishing source artifacts](#publishing-source-artifacts).

## Public source boundary

Do not commit local deployment state or secrets. In particular, keep `.dev.vars`, `.env`, `.wrangler/`, `.local-secrets/`, GitHub App private keys, and Cloudflare tokens out of commits.

Use present-tense documentation for implemented behaviour.

Decision records may document source-supported capabilities without implying
that a deployment has selected them. Label capability statements explicitly
and use conditional language. `docs/service-contract.md` is authoritative for
public behavior and security semantics. Each external deployment's reviewed
TypeScript composition is authoritative for that artifact's exact OIDC Provider
Registration and Permit Statement inventories. Do not document a concrete
deployment inventory in this public repository.

## Publishing source artifacts

Build releases from tracked files, such as a `git archive`, and run the code-change PR gates
above plus `node --run test:coverage` in that source tree. Inspect
`git status --short --ignored` before packaging: ignored local files are not
release inputs. Exclude credentials, private deployment inventory, dependency
directories, and generated local state from the source archive.

The built-artifact and production-consumer checks are included in `check`;
they validate the current build, not its provenance or checkout cleanliness.
The [deployment guide](docs/deployment.md) owns external host and composition
requirements. Repository security settings and required checks belong to the
repository's infrastructure owner, not this publication procedure.

Rotate any credential that was committed or included in a published artifact;
ignoring the file does not undo exposure. Keep consumer migration instructions
with the decision that changes their contract, including
[multiple GitHub Apps](docs/decisions/multiple-github-apps.md#consumer-migration).

## Maintaining agent instructions

`AGENTS.md` owns the coding workflow and its context pointers. Keep instructions
that protect this broker's contracts, domain terminology, runtime boundaries,
validation lanes, or publication requirements. Link to existing documentation
owners for details. When editing guidance, check repository-owned instructions
and skills used for that workflow for contradictory requirements. Keep personal
style, host configuration, and unrelated API guidance outside this repository.

This approach draws on OpenAI's
[GPT-6 Astra guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra)
and [GPT-5.6 Sol prompting guidance](https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6):
preserve outcomes, evidence, constraints, and completion criteria while removing
redundant process advice. Retain the broker's explicit security and PR gates when
pruning.

## Dependency tooling

Use Node 24 and the exact pnpm version in `packageManager`. Install it from the
repository root, then verify it before installing dependencies. When migrating
an existing Corepack installation, run `corepack disable pnpm` once first to
remove its pnpm shims.

```bash
npm install --global "$(node -p 'require("./package.json").packageManager')"
node --run pnpm:check
pnpm install --frozen-lockfile
```

CI installs the manifest pin, and the local `check` command verifies it.
`pmOnFail: ignore` keeps the lockfile as one YAML document for GitHub's dependency
graph; direct pnpm commands do not automatically select or enforce the pin.
Adding config dependencies requires reviewing that compatibility assumption.

Routine dependency updates use a three-day release age: `minimumReleaseAge: 4320` in
`pnpm-workspace.yaml` applies to pnpm resolution, including the scheduled
`pnpm-up` workflow, and the npm Dependabot configuration uses a matching
three-day cooldown. Keep these values aligned. Frozen installs also verify the lockfile against the release-age policy.

When updating the Codecov action, review its separate CLI `version` input in
`.github/workflows/ci-test.yml` too; Dependabot does not maintain that input.
Verify the OIDC upload and tokenless fork-PR upload paths for CLI updates.

Shared exact dependency versions live in the default catalog in
`pnpm-workspace.yaml`. Update the catalog entry to keep package and deployment
fixture dependencies aligned. Public peer dependency ranges remain separate.

Dependency updates use `strictPeerDependencies: false` to allow intermediate
peer conflicts while Dependabot assembles grouped updates. `autoInstallPeers: false`
keeps peer dependencies explicit. `node --run peer-dependencies:check`, included
in `check`, runs `pnpm peers check`. It rejects missing required peers and peers
outside their declared version ranges without changing the lockfile, including
when the lockfile was generated with permissive settings. The `dependencies` CI
job also rejects lockfile changes.

`node --run dedupe:check` runs `pnpm dedupe --check --ignore-scripts` in the same
CI job and local `check`. It fails when pnpm would change the lockfile through
deduplication, without editing it. Incompatible version ranges and distinct peer
contexts may still require multiple copies. Run `pnpm dedupe --ignore-scripts`
to apply deduplication, then review the lockfile and run the checks.

Dependency build scripts require an explicit decision in `allowBuilds` in
`pnpm-workspace.yaml`; `strictDepBuilds` rejects unreviewed scripts. The `esbuild`
and `workerd` install scripts are disabled; their platform packages supply the
binaries used by the validated builds and tests.

The scheduled [dependency-update workflow](.github/workflows/pnpm-up.yml) opens PRs
for pnpm and transitive dependency updates under the repository's release-age
policy. pnpm updates may include new majors and are committed separately.
Dependency installation, tests, and builds run in the resulting PR's CI.

`autoDedupe` consolidates compatible resolutions during updates, including across
workspace projects outside a command's filter. Frozen installs leave the graph
unchanged; `lockfile.includeResolutionSettings` records the selected deduplication
and linking settings.
`verifyDepsBeforeRun: error` stops pnpm scripts when dependencies are stale; it
does not guard `node --run`, so install explicitly before validation.

Workspace packages use links. pnpm 12 builds deployment copies from those links,
so builds no longer need injected-package synchronization.
