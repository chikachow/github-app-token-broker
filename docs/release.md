# Public Release Checklist

Run this checklist before making the repository public or tagging a release.

## Source Tree

- `git status --short` shows only intentional changes.
- `git status --short --ignored` has been reviewed for ignored local files that must not be packaged.
- Release artifacts are built from tracked files, for example from `git archive` or another explicit allowlist based on `git ls-files`.
- No local `.dev.vars`, `.env`, `.wrangler/`, `.local-secrets/`, private keys, generated state, or dependency directories are included in release artifacts.
- `git ls-files` contains no private keys, tokens, local absolute paths, Cloudflare account IDs, API tokens, or secret values.
- `node --run check` passes.

## Documentation

- `README.md` describes the current source repository and deployment boundary.
- `docs/service-contract.md` matches implemented behaviour.
- `docs/implementation.md` matches the workspace packages, Worker entrypoints, bindings, and verification commands.
- `docs/deployment.md` documents the dedicated private `chikachow/github-app-token-broker-deploy` contract, the exact audience Worker binding, the immutable GitHub Action client with its fixed audience and optional URL override, and the sole Node-only OIDC fixture seam intentionally consumed from a pinned source checkout.
- Checked-in OIDC Provider Registrations match the intended production trust set; any authentication-only registration is intentional and documented.
- Checked-in Token Issuance Policy Permit Statements match the intended production authorization set, and every referenced issuer has a Provider Registration.
- No dynamic issuer-trust or authorization-policy binding has been introduced.
- Deployment overlays do not override source-owned issuer trust or
  authorization policy and preserve deployment-owned routes, identifiers, rate
  limits, and secret bindings.
- Deployment validation proves the Worker audience binding exactly equals the action's fixed audience, and proves that the optional source repository URL override is either absent for the default endpoint or exactly the intended routed HTTPS destination before client enablement.
- `CONTEXT.md` remains the glossary source of truth.
- Deployment remains outside this codebase.
- Source workflows dispatch only `update-github-app-token-broker.yml` in `chikachow/github-app-token-broker-deploy`; they contain no old-service endpoint or deployment target.

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
