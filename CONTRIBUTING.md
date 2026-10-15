# Contributing

Keep changes small, explicit, and grounded in the service contract.

For a local documentation-only handoff, check formatting with the pinned tooling,
resolve changed links and fragment targets, verify documented commands against
their owning scripts, and inspect `git diff --check`, `git diff`, and
`git status --short` (including new files). See
[Implementation: Validation](docs/implementation.md#validation) for runtime and
artifact checks. Documentation-only pull requests still require the gates below.

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

Before opening or updating a pull request:

1. Run `corepack pnpm install --frozen-lockfile`.
2. Run `node --run check` and the [container integration suite](test/integration/README.md) for both Fastify and Worker. Follow its explicit Compose startup, test, and cleanup steps; both hosts are separate required CI lanes.
3. Update `docs/service-contract.md` when externally observable behaviour changes.
4. Update `docs/implementation.md` when package layout, Worker entrypoints, request flow, or bindings change.
5. Update `docs/deployment.md` when source/deployment ownership changes and the relevant decision record when consumers must migrate.
6. Update `CONTEXT.md` when a project-defined term or its meaning changes.

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

Build releases from tracked files, such as a `git archive`, and run the PR gates
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

Use Node 24 with Corepack shims first on `PATH` (`corepack enable`), then run
`corepack pnpm` from this repository's directory. `packageManager`
is the single pnpm version pin. CI installs that version with `pnpm/action-setup`,
prepends Corepack shims to `PATH`, and runs `node --run pnpm:check` before dependency
commands. Shims also select the correct version for nested script invocations. Direct global pnpm
invocations do not enforce the pin: `pmOnFail: ignore` keeps the lockfile as one
YAML document for GitHub's dependency graph. Adding config dependencies requires
reviewing that compatibility assumption.

`autoDedupe` consolidates compatible resolutions during updates, including across
workspace projects outside a command's filter. Frozen installs leave the graph
unchanged; `lockfile.includeResolutionSettings` records the selected deduplication
and linking settings. Keep the frozen-lockfile, peer and dedupe validation gates.
`verifyDepsBeforeRun: error` stops pnpm scripts when dependencies are stale; it
does not guard `node --run`, so install explicitly before validation.

Dependency resolution uses a three-day release age, aligned with npm Dependabot
cooldown where configured. Frozen installs also verify lockfile supply-chain
policy. Dependency build scripts require explicit `allowBuilds` decisions;
`strictDepBuilds` rejects unreviewed builds.

Workspace packages use links. pnpm 12 builds deployment copies from those links,
so builds no longer need injected-package synchronization.
