# Fail-closed Token Exchange observability

## Status

Decision status: Accepted.

## Context

An Installation Access Token is a newly created credential. Returning it when the broker cannot
acknowledge the corresponding high-level observation would allow an uncontrolled token to escape.
A post-mint observation alone discovers an unavailable sink only after GitHub has created the
credential, and revocation can fail. Conversely, internal OIDC remote-document cache events are
diagnostic details rather than records of a token-issuance decision.

Callback invocation is not the same as durable persistence. The broker can await a callback's
promise, but persistence guarantees depend on the concrete adapter and sink. GitHub exposes
[`DELETE /installation/token`](https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token),
authenticated with the Installation Access Token being revoked, and documents `204 No Content`
as its successful response.

## Decision

`ObserveTokenExchange` is a mandatory `Promise<void>` interface for high-level authentication,
authorization, and issuance lifecycle observations. The broker awaits every invocation. Before
the first GitHub request for a policy-permitted exchange, it awaits a token-free
`installation_access_token_issuance_started` observation. After GitHub returns a token, it awaits
`installation_access_token_issuance_succeeded` before returning that token to the Client.

If the success acknowledgement rejects, the broker stops using that observer, awaits one
best-effort `DELETE https://api.github.com/installation/token` request through the fixed-origin,
redirect-rejecting, 10-second-bounded GitHub HTTP adapter, and always returns sanitized
`500 {"error":"server_error"}` without the token. Revocation failure neither permits the token to
escape nor causes a recursive observation. Fallback logging receives only a new sanitized error,
not the observer failure, revocation failure, or token.

OIDC remote-document cache events use a separately named optional synchronous diagnostic
callback. Its exact `undefined` return type excludes the mandatory promise-returning observer, and
diagnostic callback failure is contained.

The default mandatory console adapter acknowledges completion of its console call. This decision
does not describe that acknowledgement as durable persistence. A deployment requiring durability
must supply an adapter whose promise resolves only after its sink confirms persistence.

## Consequences

- Every policy-permitted exchange adds one pre-mint observation and its latency.
- A post-mint acknowledgement failure can add up to the fixed GitHub revocation deadline before
  the broker returns `500`.
- Successful revocation invalidates the unreturned token. Failed revocation can leave it active
  until expiry.
- If GitHub creates a token but the mint response is lost, the broker does not know the credential
  needed to revoke it. The acknowledged pre-mint event records the ambiguous attempt.
- Durable sink selection, correlation identifiers, idempotency, retry policy, and sink-specific
  timeout policy remain separate deployment design decisions.

## Rejected alternatives

- Swallowing mandatory observer failures: this can return a token without its required record.
- Observing only after minting: an already-unavailable sink needlessly creates a credential and
  relies entirely on best-effort revocation.
- Treating a generic health check as the precondition: it is not bound to the exact issuance
  request.
- Sending revocation through background work: the response could complete before revocation.
- Reusing the rejected observer for a failure or revocation event: this recurses through the failed
  dependency and can obscure the terminal state.
- Claiming that `Promise<void>` establishes durability: only the concrete adapter can make that
  guarantee.
