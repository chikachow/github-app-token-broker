# Property-based testing

## Status

Decision status: Accepted.

## Context

The ordinary test suite already gives strong example-based and finite-domain
coverage. Property-based tests are useful here only when structured generation
can search a materially larger behavior space through a stable public seam.
Generated assertion volume is not evidence by itself: a property needs an
independent source of expected behavior and a generator that reaches the
interactions capable of exposing relevant defects.

## Decision

Use [fast-check](https://fast-check.dev/) through its
[official Vitest integration](https://fast-check.dev/docs/tutorials/setting-up-your-test-environment/property-based-testing-with-vitest/).
The lockfile and root `package.json` are authoritative for installed versions.

Properties use the public package interfaces under test. They do not introduce
production hooks or import private implementation helpers.

### Test admission

A permanent property must have:

- a stable invariant or independently implemented oracle;
- a structured input space too large or combinatorial for a concise table;
- constructive generators that preserve domain validity and shrink usefully;
- a bounded execution cost; and
- assertions that can disagree with production behavior.

Classify its demonstrated value as:

- **incremental** when it kills a non-equivalent fault that the relevant
  ordinary tests do not;
- **defence in depth** when it independently searches a broad domain but its
  demonstrated fault sensitivity overlaps ordinary tests; or
- **unsupported** when neither an independent invariant nor useful fault
  sensitivity is demonstrated. Unsupported properties are removed or
  redesigned.

Mutation checks establish sensitivity to a curated fault, not an exhaustive
mutation score or a defect probability. The optional
`pnpm test:mutations:property` command applies its manifest only in a temporary
clone of a clean committed revision. It runs the complete unmutated suite once,
then typechecks every mutant before running all non-property tests and the exact
responsible property. A responsible property that does not kill its mutant is
unsupported even when an ordinary regression kills the same mutant.

### Oracle boundary

The Token Issuance Policy property independently evaluates compiled policy
semantics: resource applicability, own-property Claim matching, pointwise
permission ranks, composition, and denial precedence. Its scenario construction
uses the public production factories, so it is not an independent oracle for
factory validation or policy compilation. Focused ordinary tests own those
contracts.

Repository-resource, scope, and permission properties use locally constructed
expected values and metamorphic relations. High-volume repository-resource
generation runs in Node. Deterministic examples in the conventional Workerd
suite cover the runtime boundary, including canonical host spelling and a
normalization-equivalent dot-segment path. These examples do not establish
unrestricted parity between the Node and Workerd URL implementations.

The bounded-body property compares the public reader with independently
concatenated non-empty subarray-backed chunks separated by empty chunks. The
generator constructs at least two non-empty chunks and uses only nonzero bytes,
so every case can detect both offset overwrite and empty-chunk offset drift.
Focused ordinary tests own limit rejection and transport cancellation.

The Token Exchange form property selects one single-valued field and constructs
both empty-before-non-empty and non-empty-before-empty orderings while varying
the field, remaining entry order, and empty extension noise. Every case must
reach the exchange with the same normalized request. Closed unsupported-field
and OAuth error mappings remain finite ordinary test tables.

### Discovery and runtime ownership

Node property modules are named `test/properties/**/*.property.test.ts` and are
discovered directly by the `property` Vitest project. The Workerd `unit` project
excludes that glob. Runtime-sensitive resource rejection remains in the
deterministic examples in `test/installation-access-token-request.test.ts`;
high-volume property generation does not add Workerd startup or per-case cost.

Shared modules may contain pure case construction and assertions, but never
side-effect test registration. A new property file must become runnable by
naming convention alone; no aggregator or registration list is maintained.

Run budgets and fixed examples live beside each property and are authoritative
in code. Fixed examples are added to fast-check's `numRuns` value so they do not
consume the generated-case budget. Critical authorization categories use both
constructive generated families and minimal fixed cases rather than statistical
coverage thresholds.

The bounded-body and Token Exchange form mutation lanes contain no fixed
examples. Their minimized faults are named ordinary regressions, while the
generated-only properties must independently kill the same mutants to qualify
as defence in depth.

### Failure replay and maintenance

Fast-check reports a seed, shrink path, and minimized counterexample. Preserve
those values when reproducing a failure. After diagnosis, promote a
security-relevant or structurally important minimized case into the property's
fixed examples or a named ordinary regression test.

Do not permanently pin a global seed: varied seeds retain search value. Avoid
broad arbitrary values filtered with `fc.pre` or `.filter` when the valid domain
can be generated constructively. Keep expensive fixture creation out of hooks
used by the Vitest connector because hooks run for each generated predicate.

Property budgets may be reduced only with evidence that fixed regressions and
the important generated families remain intact. Runtime measurements and
mutation classifications belong to the pull request or another source-bound
evaluation artifact, not this durable decision.

## Consequences

- Example-based and exhaustive finite-domain tests remain authoritative for
  protocol mappings and closed enumerations.
- Coverage percentages and test counts are not used as the value argument for
  property-based testing.
- Generator categories and oracle independence are reviewable parts of the
  security boundary.
- Stateful model testing is deferred until a model can remain materially
  simpler than the production state machine.
