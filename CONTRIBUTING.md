# Contributing

Keep changes small, explicit, and grounded in the service contract.

Before opening a pull request:

1. Run `pnpm install --frozen-lockfile`.
2. Run `node --run check`.
3. Run `node --run deploy:smoke` when changing the runtime-neutral or Fastify package, workspace packaging, or emitted declarations.
4. Update `docs/service-contract.md` when externally observable behaviour changes.
5. Update `docs/implementation.md` when package layout, adapters, request flow, or bindings change.
6. Update `docs/deployment.md` and `docs/release.md` when source/deployment ownership or publish-readiness checks change.
7. Update `CONTEXT.md` when a project-defined term or its meaning changes.

Do not commit local deployment state or secrets. In particular, keep `.dev.vars`, `.env`, `.wrangler/`, `.local-secrets/`, GitHub App private keys, and Cloudflare tokens out of commits.

Use present-tense documentation for implemented behaviour.

Decision records may document source-supported capabilities without implying
that a deployment has selected them. Label capability statements explicitly
and use conditional language. `docs/service-contract.md` is authoritative for
public behavior and security semantics. Each external deployment's reviewed
TypeScript composition is authoritative for that artifact's exact OIDC Provider
Registration and Permit Statement inventories. Do not document a concrete
deployment inventory in this public repository.
