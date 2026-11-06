# Tested source deployment handoff

Decision status: Accepted.

Source CI completion identifies the source revision that was tested. The update
handoff carries that exact commit SHA to the external deployment updater. It does
not let a newer source `main` replace that selection while the update is queued.
This preserves the connection to all source CI lanes, including the container
integration checks that are separate from `node --run check`.

The source workflow selects `workflow_run.head_sha` only from a successful,
completed `push` run on `main`. Manual `workflow_dispatch` requires an explicit
full `source_sha`; the current branch or workflow revision is not a default.
The receiver must independently require a successful `ci.yml` main-push run for
that exact SHA, in addition to its source provenance and consumer checks. Source
CI success does not authorize publication or replace deployment-owned review.

An updater must not move the source pin on deployment main or its update proposal backward
when a delayed or repeated event arrives. A superseded request leaves the newer
proposal unchanged. The deployment owns that state check and its publication
concurrency policy.

The alternative of selecting latest accepted `main` coalesces updates conveniently,
but a successful run for commit A does not establish that later commit B passed
the same checks. We choose exact tested revision handoff and explicit replay
when an update cannot proceed.

## Receiver-first migration

1. Update the external receiver to require `source_sha`, verify its source CI
   evidence, and preserve newer source pins before enabling this sender.
2. Update the source sender to supply the successful run's SHA and require the
   explicit SHA for manual dispatches.
3. Replay any update rejected during the transition using the intended tested
   commit's full SHA.

The old sender supplies no SHA, so the updated receiver intentionally rejects its
dispatches during the brief migration interval. Do not retain a latest-main
fallback to bridge that interval. Sending the new input to the old receiver is
also incompatible; coordinate the two reviewed changes in this order.
