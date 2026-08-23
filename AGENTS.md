# Coding agent instructions

## Reusable workflow

1. **Ground the task.** Inspect the worktree, affected code and tests, and triggered context. Preserve existing modifications and untracked files as user-owned; keep a lightweight plan for nontrivial work. Complete when the bounded concern, governing contracts, and overlapping user work are identified.
2. **Implement completely.** Make routine decisions autonomously; ask before materially changing scope, architecture, security, compatibility, or external behavior. Keep the change narrow, including inseparable adjacent work and synchronized documentation. Complete when behavior, tests, and owned documentation agree without placeholders or unexplained partial work.
3. **Verify by risk.** Use focused checks while iterating and proportionate checks for non-PR documentation work. Before opening or updating a pull request, satisfy the triggered repository PR-readiness guidance. Distinguish source defects from environmental failures before adapting code, and exhaust safe scoped alternatives. Complete when every affected validation lane passes or each boundary and unverified claim is stated precisely.
4. **Review the whole diff.** Account for every changed line, generated artifact, contract effect, compatibility consequence, and security failure path. High-risk security, protocol, or host changes require a distinct post-implementation adversarial review, independent of implementation reasoning where practical. Complete when only the bounded concern remains and every finding is resolved or surfaced.
5. **Handoff or publish deliberately.** Mutate Git history or remote state only when requested. Report the outcome, material interfaces and files, exact checks, and residual risk; test counts or coverage alone are not proof. Complete when the requested handoff is accurate and its stated gates are satisfied.

## Reusable working agreements

- Preserve public behavior, package exports, protocol identifiers, error semantics, and established terminology unless the task authorizes change. Surface compatibility consequences of security fixes while preserving fail-closed behavior.
- Use a concern-specific worktree when isolation helps. Keep authorized commits and branches concern-specific; before rebasing or publishing, verify ancestry and exact local and remote heads and use safe head matching or leases.
- Use the pinned runtime, package manager, scripts, and repository generators. Prefer platform APIs and existing dependencies. Keep dependency, toolchain, formatting, generated, and refactoring churn demonstrably necessary to the concern.
- Place behavior in the deepest runtime-neutral module that can own it; keep host adapters thin. Add abstractions for demonstrated problems and inject genuine runtime seams such as I/O, clocks, randomness, or host capabilities rather than caller-controlled trust or policy knobs or mock-only interfaces.
- Treat all untrusted boundary input as `unknown`. Validate every consumed field; reject ambiguity and unsupported values. Reject unknown fields only for closed contracts, and preserve documented additive fields. Prefer explicit canonical security inputs; use defaults only when contract-owned and unable to broaden authority. Keep trust-establishing steps fail-closed except for documented bounded, validated fallback state. Use explicit results for expected outcomes, exceptions for exceptional failures, and stable sanitized public failures.
- Route external I/O through a validated protocol trust path. Deliberately own redirect behavior, deadlines or timeouts, response-size bounds, consumed-response validation, and error classification.
- Construct structured observability from allowlisted safe fields sufficient to explain decisions and failure classes. Exclude tokens, credentials, sensitive Claims, and unnecessary attacker input.
- Use immutable validated snapshots and types or result variants that prevent meaningful invalid states. Keep comments for security invariants, deliberate exceptions, and non-obvious runtime constraints.
- Keep package exports narrow and justified by a demonstrated consumer. Verify affected package-root consumers against built JavaScript and declarations.
- Start bug fixes and observable behavior changes with a failing public-seam regression when practical. Test behavior, failure paths, state transitions, least privilege, and host boundaries with oracles capable of disagreeing with production. Keep example or exhaustive tests authoritative for finite mappings.
- Before a structural refactor, characterize behavior at the public seam; proceed only when the result demonstrably deepens or simplifies the module while preserving failure semantics.
- Verify every affected runtime, built artifact, package consumer, and deployment lane. Run risk-appropriate coverage when changed behavior or ordinary tests leave meaningful uncertainty; use the property-testing decision for mutation triggers and mechanics.
- Delegation supplies evidence, not transferred ownership: inspect delegated diffs, challenge assumptions, and independently verify material claims.

## Repository-specific triggered context

Load each reference only when its trigger applies:

- **Terminology or domain change:** read `CONTEXT.md` and preserve its established vocabulary.
- **Security, protocol, trust, public-error, or observation change:** read `SECURITY.md`, the affected section of `docs/service-contract.md`, and the relevant accepted decision. For mandatory observations, read `docs/decisions/fail-closed-token-exchange-observability.md` directly.
- **Packages, entrypoints, request flow, runtime adapters, bindings, artifacts, or validation lanes:** read `docs/implementation.md`.
- **Property tests or mutation work:** read `docs/decisions/property-based-testing.md`; it owns admission, oracle, replay, and mutation requirements.
- **Documentation ownership or any PR readiness:** follow `CONTRIBUTING.md`.
- **Accepted architecture, security, interface, or testing decisions:** use the index in `docs/README.md` and the relevant record in `docs/decisions/`. Record material new decisions or reversals; update existing records when their decision changes; leave routine conformance work with its owning documentation.
- **Uncertain security or protocol interoperability:** consult current primary specifications or official documentation unless a current explicit repository decision resolves the question.

When the request, documentation, tests, and implementation disagree, present concrete conflict evidence and resolve authoritative intent before encoding behavior.
