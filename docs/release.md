# Public Release Checklist

Run this checklist before making the repository public or tagging a release.

## Source Tree

- `git status --short` shows only intentional changes.
- `git status --short --ignored` has been reviewed for ignored local files that must not be packaged.
- Release artifacts are built from tracked files, for example from `git archive` or another explicit allowlist based on `git ls-files`.
- No local `.dev.vars`, `.env`, `.wrangler/`, `.local-secrets/`, private keys, generated state, or dependency directories are included in release artifacts.
- `git ls-files` contains no private keys, tokens, local absolute paths, Cloudflare account IDs, API tokens, or secret values.
- `node --run check` passes.
- The [container integration suite](../test/integration/README.md) passes for both Fastify and Worker using its explicit Compose startup, test, and cleanup steps.
- `node --run artifact:check` independently validates the built Token Exchange artifact contract.
- `node --run node-deploy:check` independently validates the production-pruned Fastify consumer contract.
- `node --run test:coverage` passes its configured thresholds.

## Documentation

- `README.md` describes the current source repository and deployment boundary.
- `docs/service-contract.md` matches implemented behaviour.
- `docs/implementation.md` matches the workspace packages, host entrypoints, bindings, and verification commands.
- `docs/deployment.md` keeps the Node host and Cloudflare Worker deployment boundaries clearly distinguished.
- The Worker package exposes the named composition Interface and no default production composition.
- The Fastify package exposes only the named handler-only plugin contract.
- `node-deploy:check` verifies the Fastify package's built ESM and declarations through a
  production-pruned external consumer built from the current worktree. Run release
  validation from the tracked-file source tree required above; this check does not
  enforce source cleanliness or provenance.
- The Fastify deployment fixture remains deny-all and is not a production composition; Node host
  lifecycle, admission, and composition remain externally owned.
- Deployment-owned entrypoints re-export `GitHubAppInformationEntrypoint` and
  exercise it through a named service binding; each concrete consumer tests its
  exact production binding configuration.
- The generic Wrangler entrypoint remains deny-all and contains no deployment inventory.
- No dynamic issuer-trust or authorization-policy binding has been introduced.
- An external deployment owns and independently tests the OIDC Provider Registrations and Token Issuance Policy compiled into its artifact.
- Cloudflare Worker deployment validation proves its audience binding exactly equals the audience requested by its Clients and separately proves that Clients use the intended routed HTTPS Token Exchange Endpoint.
- The runtime binding inventory has no configurable GitHub API destination; all App-credential requests remain fixed to `https://api.github.com` and retain the 10-second broker deadline.
- Installation Access Token integration tests cover both legacy opaque and JWT-shaped GitHub token values and prove that no temporary stateful-token override is sent.
- The GitHub App Information service binding remains explicitly trusted, read-only, non-public, unable to mint tokens or expose the private key, and unable to enumerate installation repositories.
- `CONTEXT.md` remains the glossary source of truth.
- Deployment remains outside this codebase.
- Source workflows do not hard-code deployment-owned audience or route values; any Token Exchange Endpoint override comes from repository configuration.

## OIDC terminology migration

Consumers of the OIDC package use `idTokenHeaderKeyId` in
`OidcVerificationEvidence` and `VerifiedOidcIdToken`, replacing `resolvedKeyId`.
Observation consumers use `subject_token.id_token_header_key_id`, replacing
`subject_token.resolved_key_id`.
The value is unchanged: it is the verified token header's `kid`, or `null` when
absent, including when a singleton JWK Set supplies a verification key.
Update structured-log queries, dashboards, and observation adapters when adopting
this revision. The old field is not emitted alongside the new field.

Rebuild source consumers against the renamed exports before deployment.

## Repository Settings

Enable these settings after publication:

- GitHub secret scanning
- secret scanning push protection
- Dependabot security updates
- required `ci` check on protected branches, aggregating all validation jobs, including both container integration hosts
- private vulnerability reporting, if available

## Operational Secrets

Rotate any secret that has ever been committed or copied into an artifact that may become public. Do not rely on `.gitignore` as evidence that a secret was never exposed.

If a local private key, token, `.dev.vars`, `.env`, or generated Wrangler state exists in the working tree during publication, treat it as an artifact-packaging risk even when Git ignores it.
