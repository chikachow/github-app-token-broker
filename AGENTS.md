# Coding agent instructions

Security guarantees, authorization boundaries, public contracts, and required
validation gates are obligations. Design and testing preferences below are
defaults: choose methods that satisfy those obligations and explain consequential
deviations. Routine implementation choices do not require separate approval.

## Workflow

1. **Ground the task.** Inspect the worktree, affected code and tests, and references triggered below. Preserve existing modifications and untracked files; keep a lightweight plan for nontrivial work. Complete when the bounded concern, governing contracts, and overlapping user work are identified.
2. **Complete the requested work.** Resolve routine choices from repository evidence and carry prior agreement forward. Ask only when an unresolved requirement materially changes the agreed contract, scope, or authorization; continue independent work while awaiting the answer. Complete when the requested outcome is implemented and behavior, tests, and owned documentation agree. For reviews and plans, deliver analysis without implementing unrequested changes.
3. **Verify by risk.** Follow [validation scope](CONTRIBUTING.md#validation-scope). Distinguish source defects from environmental failures and exhaust safe scoped alternatives. Verification is complete when affected checks pass; report unavailable checks as unverified.
4. **Review the whole diff.** Account for every changed line, generated artifact, contract effect, and security failure path. Changes to authentication, authorization, credential handling, mandatory observations, or host trust guarantees require a fresh adversarial reviewer when available. Give the reviewer the request, governing contracts, and complete diff; require concrete failure scenarios and evidence. If unavailable, disclose the fallback review and its limits; an implementer's second pass is not independent review. Incidental edits in security-related files do not trigger this requirement. For implementation tasks, resolve actionable in-scope findings and rerun affected checks before completion. For review tasks, complete when findings are supported by evidence and distinguish defects, unmet outcomes, unresolved contract questions, and optional improvements.
5. **Hand off deliberately.** Mutate Git history or remote state only when requested. Report each requested outcome, supporting evidence, exact checks, and residual risk. A genuine blocker permits an incomplete handoff: identify what remains, why safe scoped alternatives cannot resolve it, and the input or access needed to continue. Reporting unfinished work does not make it complete. If an instruction blocks authorized work, cite its file and exact rule, distinguishing the requirement from your interpretation.

## Design and contracts

- Preserve public behavior, package exports, protocol identifiers, error semantics, and established terminology unless the task authorizes change. Surface compatibility consequences of security fixes while preserving fail-closed behavior. For terminology or domain changes, read [CONTEXT.md](CONTEXT.md).
- Choose the simplest cohesive design for the whole affected concern, including callers and lifecycle transitions. Justify abstractions and safeguards by concrete requirements; prefer helpers when they expose a meaningful operation or clarify the caller. Before structural refactoring, characterize behavior, preferably at the public seam, and identify the improvement while preserving failure semantics.
- Prefer placing behavior in the deepest runtime-neutral module that can own it and keeping host adapters thin. Prefer injecting genuine runtime seams such as I/O, clocks, randomness, or host capabilities; keep trust and authorization policy out of runtime dependency knobs. Justify package exports by demonstrated consumers. For packages, entrypoints, request flow, adapters, bindings, or artifacts, read [Implementation](docs/implementation.md).
- Use the pinned runtime, package manager, scripts, and generators. Prefer platform APIs and existing dependencies. Keep dependency, toolchain, formatting, generated, and refactoring changes necessary to the concern. Comments should explain invariants, deliberate exceptions, and non-obvious runtime constraints.

## Trust boundaries

- For security, protocol, trust, public-error, or observation changes, read [SECURITY.md](SECURITY.md), the affected [service contract](docs/service-contract.md) section, and the relevant accepted decision. For mandatory observations, read the [fail-closed observability decision](docs/decisions/fail-closed-token-exchange-observability.md) directly.
- Treat untrusted input as `unknown`; validate every consumed field at its owning boundary and pass typed values inward. Reject ambiguity and unsupported values; reject unknown fields only for closed contracts and preserve documented additive fields. Internal types do not establish trust for externally supplied values. Preserve immutable snapshots where later authentication, authorization, or lifecycle decisions depend on stable values, including verified Claims, normalized Installation Access Token Requests, and compiled policy. Other validated values follow their owning contracts.
- Use explicit canonical security inputs. Defaults must be contract-owned and unable to broaden authority. Keep trust-establishing steps fail-closed except for documented bounded, validated fallback state. Represent expected outcomes explicitly and sanitize exceptional public failures.
- Route external I/O through a validated protocol trust path that owns redirects, deadlines, response-size bounds, consumed-response validation, and error classification.
- Build observations from allowlisted safe fields sufficient to explain decisions and failure classes. Exclude credentials, sensitive Claims, and unnecessary attacker input.

## Evidence and tests

- Support implementation claims with code or direct experiments; support external behavior and compatibility claims with current primary sources or direct experiments. Consult primary specifications for uncertain security or protocol interoperability unless an explicit repository decision resolves it.
- Prefer starting bug fixes and observable behavior changes with a failing public-seam regression. Exercise behavior, failure paths, state transitions, least privilege, and host boundaries with oracles capable of disagreeing with production. Keep example or exhaustive tests authoritative for finite mappings.
- Verify affected package-root consumers against built JavaScript and declarations. Use coverage when ordinary tests leave meaningful uncertainty. For property tests or mutation work, read the [property-testing decision](docs/decisions/property-based-testing.md) for admission, oracle, replay, and mutation requirements.
- When delegating, inspect the resulting diffs, challenge assumptions, and independently verify material claims.

## Documentation and change ownership

- For documentation changes or PR readiness, follow [CONTRIBUTING.md](CONTRIBUTING.md). Keep each fact and policy in one authoritative place; use task-triggered pointers for specialized guidance and keep evaluation history and completed plans with their change records.
- For architecture, security, interface, or testing decisions, use the [decision index](docs/README.md) and relevant record. Record material new decisions or reversals; update records whose decisions change. Resolve concrete disagreements among the request, contracts, tests, and implementation before encoding behavior.
- Use a concern-specific worktree when isolation helps. Keep authorized commits and branches concern-specific; before rebasing or publishing, verify ancestry and exact local and remote heads and use safe head matching or leases.
