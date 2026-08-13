# Public Release Checklist

Run this checklist before making the repository public or tagging a release.

## Source Tree

- `git status --short` shows only intentional changes.
- `git status --short --ignored` has been reviewed for ignored local files that must not be packaged.
- Release artifacts are built from tracked files, for example from `git archive` or another explicit allowlist based on `git ls-files`.
- No local `.dev.vars`, `.env`, `.wrangler/`, `.local-secrets/`, private keys, generated state, or dependency directories are included in release artifacts.
- `git ls-files` contains no private keys, tokens, local absolute paths, Cloudflare account IDs, API tokens, or secret values.
- `node --run check` passes.
- `node --run deploy:smoke` proves the emitted Node JavaScript and declarations work from a pnpm production deploy artifact.

## Documentation

- `README.md` describes the current source repository and deployment boundary.
- `docs/service-contract.md` matches implemented behaviour.
- `docs/implementation.md` matches the workspace packages, Worker and Fastify adapters, bindings, and verification commands.
- `docs/deployment.md` documents only the generic interface between this source repository and an external deployment system.
- The Worker package exposes the named composition Interface and no default production composition.
- The Fastify plugin receives only a preconstructed handler and documents external admission control; it owns no listener or health route.
- The generic Wrangler entrypoint remains deny-all and contains no deployment inventory.
- No dynamic issuer-trust or authorization-policy binding has been introduced.
- An external deployment owns and independently tests the OIDC Provider Registrations and Token Issuance Policy compiled into its artifact.
- Deployment validation proves the Worker audience binding exactly equals the audience requested by its Clients and separately proves that Clients use the intended routed HTTPS Token Exchange Endpoint.
- `CONTEXT.md` remains the glossary source of truth.
- Deployment remains outside this codebase.
- Source workflows do not hard-code deployment-owned audience or route values; any Token Exchange Endpoint override comes from repository configuration.

## Repository Settings

Enable these settings after publication:

- GitHub secret scanning
- secret scanning push protection
- Dependabot security updates
- required `ci` check on protected branches
- private vulnerability reporting, if available

## Operational Secrets

Rotate any secret that has ever been committed or copied into an artifact that may become public. Do not rely on `.gitignore` as evidence that a secret was never exposed.

If a local private key, token, `.dev.vars`, `.env`, or generated Wrangler state exists in the working tree during publication, treat it as an artifact-packaging risk even when Git ignores it.
