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
three-day cooldown. Keep these values aligned. This controls newly resolved
versions; a frozen install of the reviewed lockfile is not a release-age audit.

When updating the Codecov action, review its separate CLI `version` input in
`.github/workflows/ci-test.yml` too; Dependabot does not maintain that input.
Verify the OIDC upload and tokenless fork-PR upload paths for CLI updates.

Shared exact dependency versions live in the default catalog in
`pnpm-workspace.yaml`. Update the catalog entry to keep package and deployment
fixture dependencies aligned. Public peer dependency ranges remain separate.

Dependency resolution rejects missing or incompatible peer dependencies through
`strictPeerDependencies`; `autoInstallPeers: false` keeps peer dependencies explicit.

Dependency build scripts require an explicit decision in `allowBuilds` in
`pnpm-workspace.yaml`; `strictDepBuilds` rejects unreviewed scripts. The `esbuild`
and `workerd` install scripts are disabled; their platform packages supply the
binaries used by the validated builds and tests.

Before opening or updating a pull request:

1. Run `pnpm install --frozen-lockfile`.
2. Run `node --run check` and the [container integration suite](test/integration/README.md) for both Fastify and Worker. Follow its explicit Compose startup, test, and cleanup steps; both hosts are separate required CI lanes.
3. Update `docs/service-contract.md` when externally observable behaviour changes.
4. Update `docs/implementation.md` when package layout, Worker entrypoints, request flow, or bindings change.
5. Update `docs/deployment.md` and `docs/release.md` when source/deployment ownership or publish-readiness checks change.
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
