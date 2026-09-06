# Contributing

Keep changes small, explicit, and grounded in the service contract.

For a local documentation-only handoff, check formatting with the pinned tooling,
resolve changed links and fragment targets, verify documented commands against
their owning scripts, and inspect `git diff --check`, `git diff`, and
`git status --short` (including new files). See
[Implementation: Validation](docs/implementation.md#validation) for runtime and
artifact checks. Documentation-only pull requests still require the gates below.

Before opening or updating a pull request:

1. Run `pnpm install --frozen-lockfile`.
2. Run `node --run check` and `node --run test:integration`. The integration command requires Docker with Compose; it is a separate required CI lane.
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
