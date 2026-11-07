# Package compilation and deployment bundling

## Status

Accepted.

## Context

Internal package imports must behave consistently. A consumer should not need to
know whether a dependency exports TypeScript source or built JavaScript, or add a
bundler exception after importing an otherwise ordinary helper. Library builds
must remain usable by their target runtime after production dependency pruning.

The broker also has two deployment hosts with different packaging needs:
Fastify runs on Node, while Worker deployments must retain their Cloudflare
exports and bindings. Those differences belong to deployment builds.

## Decision

Compile every library package to ESM and declarations, preserving module and
package imports. Use the TypeScript compiler with shared settings and package-local
source/output directories. Keep existing public package names, subpaths, runtime
exports, and type interfaces. Export only built artifacts through package exports.

Each library declares its direct dependencies. It does not embed another package,
choose exceptions for individual dependencies, or require consumers to load its
TypeScript source. Host-provided imports remain imports for the selected host to
resolve.

Deployment builds own dependency bundling and the final runnable artifact.
The [implementation guide](../implementation.md#package-artifacts) owns the build
commands and configuration layout; the [deployment guide](../deployment.md) owns
host and external-consumer requirements.

## Alternatives

Keeping mixed source and built exports requires consumers to distinguish packages
by their implementation. Per-package bundling exceptions preserve that hidden
knowledge and spread it to each new consumer.

Bundling every internal dependency into each library gives a uniform rule but can
embed duplicated implementation and dependency initialization in adapters. It also
makes deployment-time dependency inspection less informative. Library compilation
preserves sharing and leaves the final bundling choice with the deployment.

## Consequences

Consumers of a source checkout must build the workspace before importing package
exports. The dependency-ordered root build establishes this prerequisite. Package
builds clean their previous output so deleted modules cannot survive in artifacts.

Behavioral tests consume compiled modules, and source maps preserve source-level
coverage reporting. Mutation checks must rebuild changed source before testing.
Production-pruned runtime and declaration consumers and both container hosts
remain required validation. A successful source test does not substitute for those
artifact checks.
