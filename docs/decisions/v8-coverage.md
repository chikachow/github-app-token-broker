# V8 coverage collection

## Status

Decision status: Accepted.

## Context

[Cloudflare's Vitest integration supports V8 coverage](https://github.com/cloudflare/workers-sdk/pull/15591)
in its managed Workerd runtime. The source suite can therefore collect native V8
coverage in both Node and Workerd without source coverage instrumentation.

## Decision

Use Vitest's V8 provider for the source suite. Accept its
[documented measurement limitations](https://github.com/AriPerkkio/ast-v8-to-istanbul#limitations):
an unexecuted default argument can appear covered when its line executes, and
statements after a throwing call can appear covered without executing.
Behavioral assertions remain necessary for defaults and failure paths; a green
coverage report does not establish those outcomes.

## Consequences

Provider changes can alter function and branch counts without changing exercised
behavior. Compare source inventories and uncovered locations as well as totals
when changing providers. The [implementation guide](../implementation.md#validation)
owns collection boundaries and the configured validation lanes.
