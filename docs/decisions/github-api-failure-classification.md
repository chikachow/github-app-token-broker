# GitHub API Failure Classification

## Status

Decision status: Accepted.

## Context

After Token Issuance Policy permits a request, github-app-token-broker uses its own GitHub App
credentials to resolve the target installation and request an installation
access token. The Client does not select those credentials or construct either
GitHub API request.

The former issuance boundary treated GitHub `401`, `403`, and `404` responses as
an invalid OAuth target. That classification attributed a downstream response
to the Client's `resource` even after github-app-token-broker had already established that the
Repository Resource and Requested Permissions were supported. It was also unreliable:
GitHub can use `404` for an existing private resource when authentication or
permissions are insufficient, and uses `403` for both ordinary forbidden
responses and rate limits.

Network failures and GitHub rate limits were also reported as undifferentiated
internal failures even though they are conditions for which a later retry can
succeed.

## Decision

The issuance boundary classifies failures by ownership and retryability rather
than inferring OAuth target validity from a GitHub response status.
`packages/github` owns the mapping from raw GitHub transport outcomes to an
explicit issuance result containing one of the internal reasons below and
sanitized operational evidence. Token Exchange owns the separate mapping from
that reason to its stable OAuth response and never inspects a raw GitHub error.

| Issuance condition                            | Internal reason        | github-app-token-broker Token Endpoint response |
| --------------------------------------------- | ---------------------- | ----------------------------------------------- |
| missing or invalid service-owned private key  | `internal_failure`     | `500 {"error":"server_error"}`                  |
| request rejected with `400`                   | `internal_failure`     | `500 {"error":"server_error"}`                  |
| service-owned credentials rejected with `401` | `internal_failure`     | `500 {"error":"server_error"}`                  |
| validation rejected with `422`                | `internal_failure`     | `500 {"error":"server_error"}`                  |
| non-rate-limit `403`                          | `upstream_failure`     | `502 {"error":"server_error"}`                  |
| `404`                                         | `upstream_failure`     | `502 {"error":"server_error"}`                  |
| rate-limit `403` or `429`                     | `upstream_unavailable` | `503 {"error":"temporarily_unavailable"}`       |
| `503`                                         | `upstream_unavailable` | `503 {"error":"temporarily_unavailable"}`       |
| transport failure, including deadline expiry  | `upstream_unavailable` | `503 {"error":"temporarily_unavailable"}`       |
| malformed or invalid successful response      | `upstream_failure`     | `502 {"error":"server_error"}`                  |
| other GitHub `5xx`                            | `upstream_failure`     | `502 {"error":"server_error"}`                  |
| otherwise unclassified failure                | `internal_failure`     | `500 {"error":"server_error"}`                  |

### Protocol extension status

These HTTP-status and error-code pairs are deliberate github-app-token-broker protocol
extensions. RFC 8693 delegates token-exchange errors to RFC 6749 section 5.2,
which normally specifies HTTP `400` for Token Endpoint error responses. The
IANA OAuth Extensions Error Registry registers `server_error` and
`temporarily_unavailable` for the authorization endpoint, not the Token
Endpoint. github-app-token-broker reuses those names at the Token Endpoint with `500`, `502`,
and `503` statuses as an explicit service contract; this decision does not
claim that those pairs comply with RFC 6749 section 5.2. Clients must interpret
the complete status and error-code pair.

Only Token Issuance Policy's single evaluation can produce
`target_unsupported` and therefore `invalid_target` after request normalization.
A GitHub response cannot retroactively change that policy outcome.

### Fixed destination and deadline

The broker sends every GitHub request to `https://api.github.com`; neither a
deployment binding nor a Client value can select another credential
destination. Redirect responses are rejected before any follow-up request, so
GitHub App credentials are not forwarded through redirects. Each request has
one broker-owned 10-second deadline spanning the Fetch operation through
receipt of response headers and consumption of the
complete bounded response body. A caller abort is composed with, rather than
replacing, this deadline. Deadline expiry and other transport failures use the
`upstream_unavailable` classification.

### Rate-limit evidence

GitHub documents primary and secondary rate limits as `403` or `429` responses.
The implementation treats `429` as rate limited directly. A `403` is rate
limited only when at least one reviewed GitHub signal is present:

- `x-ratelimit-remaining: 0`;
- a `retry-after` header; or
- a bounded JSON error body whose string `message` contains `rate limit`.

The error-body read is bounded. An absent, oversized, unreadable, malformed, or
differently shaped body contributes no rate-limit evidence and the `403`
remains an upstream failure. Response bodies are not logged or returned to the
Client.

### Response and logging boundary

The github-app-token-broker Token Endpoint response contains only the documented error code. It
does not expose GitHub response bodies, GitHub credentials, installation access
tokens, network exception messages, or installation identifiers that were not
yet resolved.
Operational logs retain the sanitized GitHub request path, actual upstream
status in `error.upstream_status` when available, the broker's separately
labelled status in `error.status`, the Token Issuance Policy outcome, and a
target installation ID only after resolution succeeds. That resolved ID
remains in the log context if the subsequent token-minting request fails. A
broker-selected `502` for an invalid successful representation is therefore
not recorded as though GitHub returned HTTP `502`.

This decision does not add retries or forward GitHub `retry-after` or
`x-ratelimit-reset` values. Retry policy and externally observable retry headers
require a separate decision.

## Rationale

- RFC 8693 `invalid_target` describes an Authorization Server that is unwilling
  or unable to issue for a requested target. It is not a generic translation of
  a later Resource Server failure.
- A GitHub `401` concerns credentials owned by github-app-token-broker, so it is an internal
  configuration or credential failure rather than a Client error.
- Missing or invalid local private-key material is likewise a service-owned
  configuration failure and is never classified as a GitHub `5xx` response.
- GitHub `422` after policy approval validates a request that github-app-token-broker composed;
  it is a service/configuration failure rather than `invalid_scope`. GitHub,
  not github-app-token-broker, remains authoritative for permission-name and level
  compatibility.
- GitHub documents that a private resource can produce `404` when authentication
  is missing or insufficient. Treating `404` as `invalid_target` would be both
  misleading and a poor resource-existence signal.
- GitHub documents `403` and `429` rate-limit responses and their distinguishing
  headers and error message. Those signals justify a retryable classification.
- A malformed or schema-invalid successful GitHub response violates the
  operation's upstream response contract and is therefore an upstream failure.
- github-app-token-broker uses HTTP `502` as an application-level distinction between a
  non-retry-classified upstream failure and an internal request or credential
  failure. It does not claim that every classified GitHub `403` or `404` is an
  invalid upstream HTTP response under RFC 9110. HTTP `503` and github-app-token-broker's
  `temporarily_unavailable` Token Endpoint extension tell the Client that a
  later retry can succeed.

## Consequences

- Clients receive errors aligned with what they can act on.
- Downstream GitHub responses do not become an authorization or repository
  existence oracle.
- Operators can distinguish internal, upstream, and temporarily unavailable
  failures without exposing sensitive upstream detail.
- `invalid_target` remains owned by request normalization and Token Issuance
  Policy target support.

## Rejected alternatives

### Preserve the former status mapping

Rejected because it attributed service-owned credential and ambiguous GitHub
authorization failures to the Client's target.

### Map every GitHub failure to `500 server_error`

Rejected because it hides the upstream boundary and gives no retry signal for
transport failures, rate limits, or GitHub `503` responses.

### Map every GitHub failure to `502 server_error`

Rejected because rate limits and unavailability are meaningfully retryable, and
`400` or `401` indicates a request or credential constructed and owned by
github-app-token-broker.

### Forward GitHub error bodies or retry headers

Rejected for this decision. Error bodies can contain unstable or sensitive
detail, and forwarding retry metadata would introduce an additional public
contract requiring its own validation and policy.

## References

- [OAuth 2.0 Token Exchange, RFC 8693 section 2.2.2](https://www.rfc-editor.org/rfc/rfc8693.html#section-2.2.2)
- [OAuth 2.0, RFC 6749 section 5.2](https://www.rfc-editor.org/rfc/rfc6749.html#section-5.2)
- [IANA OAuth Extensions Error Registry](https://www.iana.org/assignments/oauth-parameters/oauth-parameters.xhtml)
- [HTTP Semantics, RFC 9110 sections 15.6.3 and 15.6.4](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.6.3)
- [GitHub REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28)
- [GitHub REST API troubleshooting](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api?apiVersion=2022-11-28)
