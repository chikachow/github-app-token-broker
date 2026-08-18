# TypeScript property-based testing survey

Research date: 2026-08-17. Updated 2026-08-18 after implementation review.

## Recommendation at the research date

Use `fast-check` 4.9.0 with the official `@fast-check/vitest` 0.4.1 connector.
It provided the strongest combination of TypeScript and ESM support, structural
shrinking, seed-and-path replay, asynchronous properties, model-based APIs, and
maintained Vitest 4 integration. The selection is recorded durably in the
[property-based testing decision](../decisions/property-based-testing.md); the
lockfile is authoritative for current versions.

The connector enriches Vitest's `test` and `it` APIs, coordinates async
properties and lifecycle hooks, and remains opt-in per test module
([official integration guide](https://fast-check.dev/docs/tutorials/setting-up-your-test-environment/property-based-testing-with-vitest/)).
Fast-check reports minimized counterexamples with replay parameters and supports
command-based state models when a small independent model exists
([runner documentation](https://fast-check.dev/docs/core-blocks/runners/),
[model-based testing](https://fast-check.dev/docs/advanced/model-based-testing/)).

## Survey

| Option                                                                                                                                                             | Status at the research date                                                                                                                             | Assessment for this repository                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [`fast-check` 4.9.0](https://www.npmjs.com/package/fast-check/v/4.9.0) with [`@fast-check/vitest` 0.4.1](https://www.npmjs.com/package/@fast-check/vitest/v/0.4.1) | Maintained JavaScript engine with an official typed Vitest 4 connector, async properties, shrinking, replay, commands, and deterministic scheduling.    | Adopt. It fits the existing Node, TypeScript, ESM, Vitest, and Workerd test topology without a production dependency.                    |
| [`@hegeldev/hegel` 0.4.5](https://www.npmjs.com/package/@hegeldev/hegel/v/0.4.5)                                                                                   | Modern independent Rust engine exposed through native FFI; typed ESM and direct use from Vitest, but explicitly beta.                                   | Strongest independent challenger. Reconsider after a stable release or a runtime model that avoids platform-specific native binaries.    |
| [`jsproptest` 0.5.6](https://www.npmjs.com/package/jsproptest/v/0.5.6)                                                                                             | Active independent TypeScript generator and shrink-tree implementation with stateful actions; published runner is synchronous and CommonJS-oriented.    | Do not adopt. Async behavior, replay ergonomics, packaging, and Vitest integration are weaker for this project.                          |
| [`@effect/vitest`](https://www.npmjs.com/package/@effect/vitest)                                                                                                   | Vitest facade whose property facilities delegate to fast-check; compatible Vitest 4 support was on an Effect 4 release-candidate line.                  | Do not add solely for property tests. It is not an independent engine and would add an unrelated Effect dependency graph.                |
| [`vimonkey` 0.2.5](https://www.npmjs.com/package/vimonkey/v/0.2.5)                                                                                                 | ESM Vitest sequence fuzzer with seed replay, filesystem regression cases, and deletion-only sequence shrinking; its published plugin hooks were a stub. | Do not adopt for policies, maps, URLs, forms, or byte arrays. It targets action sequences rather than structurally shrunk domain values. |
| [`@traversable/zod-test` 0.0.28](https://www.npmjs.com/package/@traversable/zod-test/v/0.0.28)                                                                     | Zod 4 to fast-check adapter, not a runner or independent engine.                                                                                        | Defer. Explicit domain arbitraries express the relevant authorization and URL relationships more clearly.                                |
| [`@antithesishq/bombadil` 0.7.0](https://www.npmjs.com/package/@antithesishq/bombadil/v/0.7.0)                                                                     | Experimental standalone property exploration for browser and terminal UIs, with stateful traces rather than a Vitest value-generator API.               | Out of scope. This repository has no browser or terminal UI under test.                                                                  |
| [`zod-fast-check` 0.10.1](https://www.npmjs.com/package/zod-fast-check/v/0.10.1)                                                                                   | Schema adapter with peer ranges for older Zod and fast-check releases.                                                                                  | Incompatible with the selected dependency line at the research date.                                                                     |
| [`JSVerify` 0.8.4](https://www.npmjs.com/package/jsverify/v/0.8.4)                                                                                                 | Older CommonJS engine with shrinking and replay but no current Vitest integration or model API.                                                         | Reject for new tests.                                                                                                                    |
| [`TestCheck.js` 1.0.0-rc.2](https://github.com/leebyron/testcheck-js)                                                                                              | Inactive release-candidate API with synchronous TypeScript property signatures.                                                                         | Reject for new tests.                                                                                                                    |

New publication dates were not treated as evidence of a better engine. Schema
adapters and runner facades were distinguished from independent engines, and
random-data libraries were excluded unless they also supplied shrinking and
deterministic reproduction.

The Hegel assessment is grounded in its
[beta README](https://github.com/hegeldev/hegel-typescript/tree/v0.4.5),
[native package manifest](https://github.com/hegeldev/hegel-typescript/blob/v0.4.5/package.json),
[runner implementation](https://github.com/hegeldev/hegel-typescript/blob/v0.4.5/src/runner.ts),
and [FFI migration note](https://github.com/hegeldev/hegel-typescript/blob/v0.4.5/CHANGELOG.md#030---2026-06-26).
The runner loads a platform `libhegel` and Node filesystem/path modules. That is
the basis for treating it as Node-only here, not merely its declared Node
engine.

JSProptest's [`Property`](https://github.com/kindone/jsproptest/blob/b33cef27793e7a9a444fa22cf2295cb1f9ac3c53/src/Property.ts)
owns generation, seeding, and shrink traversal, while
[`StatefulProperty`](https://github.com/kindone/jsproptest/blob/b33cef27793e7a9a444fa22cf2295cb1f9ac3c53/src/stateful/statefultest.ts)
owns action generation and shrinking. Its
[published manifest and types](https://github.com/kindone/jsproptest/blob/b33cef27793e7a9a444fa22cf2295cb1f9ac3c53/package.json)
are the basis for the CommonJS, no-Vitest-adapter, and synchronous-callback
assessment.

Effect's
[`FastCheck` module](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/testing/FastCheck.ts)
re-exports fast-check, and its
[Vitest implementation](https://github.com/Effect-TS/effect/blob/main/packages/vitest/src/internal/internal.ts)
delegates property execution to `fc.property` and `fc.asyncProperty`. It is a
useful facade for an Effect application, but not an independent search engine.

Vimonkey's source supplies a
[`test.fuzz` wrapper](https://github.com/beorn/vimonkey/blob/ce573fdf743eb9b48864a55df63dbb2dbbfb0922/src/fuzz/test-fuzz.ts),
[deletion-only shrinker](https://github.com/beorn/vimonkey/blob/ce573fdf743eb9b48864a55df63dbb2dbbfb0922/src/fuzz/shrink.ts),
and [saved regression cases](https://github.com/beorn/vimonkey/blob/ce573fdf743eb9b48864a55df63dbb2dbbfb0922/src/fuzz/regression.ts);
its [plugin hooks](https://github.com/beorn/vimonkey/blob/ce573fdf743eb9b48864a55df63dbb2dbbfb0922/src/plugin.ts)
were only planned. Bombadil's
[project README](https://github.com/antithesishq/bombadil/tree/v0.7.0)
defines its browser/terminal scope and experimental status.

Fast-check's scheduler was not a reason to adopt it for Worker integration.
Official guidance notes that asynchronous work started through uncontrolled
sources such as `fetch` may not be schedulable
([race-condition guidance](https://fast-check.dev/docs/advanced/race-conditions/)).
Runtime-boundary tests therefore need deliberate fakes or direct Workerd
execution rather than an assumed universal scheduler.

## Uncommitted candidates

These are research leads, not roadmap commitments:

- bounded body reading across byte-array partitions and limits around the exact
  body length;
- Token Exchange form-multimap classification under entry permutation,
  duplicate values, and empty extension noise; and
- a small OIDC metadata/JWKS cache command model covering freshness, stale
  eligibility, backoff, cooldown, and identity changes.

Each candidate must independently satisfy the durable admission criteria before
implementation. In particular, the OIDC model should not be built if it needs
to duplicate the production freshness parser, error classifier, or refresh
state machine. Closed algorithm lists and exact OAuth error mappings should
remain finite example tables rather than randomized properties.
