# Bounded Token Exchange lifecycle

Decision status: Accepted.

Per-request HTTP deadlines do not bound admission, body acquisition, secret
resolution, or mandatory observations. The broker therefore owns a finite
success budget while preserving responsibility for a credential that may already
have been minted. The [service contract](../service-contract.md#exchange-lifetime-and-credential-release)
owns the numeric limits, validation rules, and public failure mappings.

Cancellation is terminal before release. Each pre-mint transition checks the
request lifetime. Shared issuer refresh work remains issuer-owned and is retained
through the host capability when one waiter stops waiting. An already-started
mint may finish only within its existing transport deadline so a recovered token
can be revoked. Revocation is awaited and independently bounded; it does not reuse
the cancelled success signal. There are no automatic mint retries.

The GitHub issuer validates returned authority against the authorized request and
retains recoverable tokens from otherwise invalid decoded responses for compensation.
After mandatory acknowledgement, the Token Endpoint still owns a discard capability
until it synchronously checks expiry and cancellation and constructs the response.
This is the release boundary; actual network delivery is not a transactional
acknowledgement by the Client. A rejected credential cannot become successful when
a late secret or observer completes.

Exact returned permission evidence is required without an implicit baseline.
Optional repository inventory is checked when present; omission remains compatible
with GitHub's documented response. Real GitHub interoperability is a deployment
rollout gate. Changing authority semantics to accommodate a vendor baseline requires
an explicit decision, rather than an undocumented parser exception.

Rejected alternatives were a top-level timeout race that abandons mint ownership,
aborting shared refreshes when one waiter disconnects, and retrying ambiguous mint
attempts. Durable recovery infrastructure is not introduced: a lost response or
terminated host can leave an unknown or unrecoverable token active until expiry.
Mandatory acknowledgement remains distinct from durability, as recorded in the
[observability decision](fail-closed-token-exchange-observability.md).
