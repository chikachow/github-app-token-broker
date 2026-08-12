# OIDC ID Token authentication

## Status

Decision status: Accepted and amended below.

Implementation status: Complete. The authentication architecture remains
active; the original Token Policy boundary is retained as historical text and
superseded by the amendment below.

## Amendment: CEL-free Token Issuance Policy

The authentication and authorization separation remains accepted, but the
authorization-specific portions of the original decision below are superseded
by the [CEL-free Token Issuance Policy](cel-free-token-issuance-policy.md)
decision. Token Policy is now Token Issuance Policy: closed Permit Statements
over Subject Token Claims, an exact Repository Resource, and Requested
Permissions replace CEL conditions and exact whole-request rule matching.

OIDC Provider Registrations now require an explicitly present OIDC ID Token
Profile field whose value may be `null`. A non-null profile still distinguishes
the accepted provider-specific token kind after central verification; `null`
means central OIDC validation is sufficient. Registration still authenticates
an issuer without authorizing token issuance.

The current [service contract](../service-contract.md) distinguishes registered
OAuth Token Endpoint errors from github-app-token-broker protocol extensions. In particular,
the `500` and `503` mappings for authentication failures reuse `server_error`
and `temporarily_unavailable` as github-app-token-broker Token Endpoint extensions; they are not
claims of compliance with RFC 6749 section 5.2. This clarification governs the
original text's historical reference to an “OAuth response contract.”

The historical phrase “repository-scoped GitHub App installation access
token” means that issuance was narrowed to one selected repository. It does
not exclude Requested Permissions whose GitHub permission keys apply at an
organization or account level. Current terminology and behavior are defined by
the [domain glossary](../../CONTEXT.md) and [service contract](../service-contract.md).

The original decision text is retained below so the record continues to show
the architecture and policy boundary that was accepted before this amendment.

## Context

github-app-token-broker is an OAuth 2.0 Security Token Service. An automation workload sends an
OpenID Connect ID Token as the RFC 8693 `subject_token` to github-app-token-broker's Token
Endpoint and requests a repository-scoped GitHub App installation access token.

The protocol roles are:

- the automation workload is the OAuth Client for the token exchange;
- github-app-token-broker is the Authorization Server exposing the Token Endpoint;
- each external issuer is an OpenID Provider for the incoming ID Token; and
- the GitHub API is the Resource Server for the issued installation access
  token.

The Client is not necessarily the Subject represented by the ID Token. Client
Authentication is also distinct from subject-token authentication; github-app-token-broker does
not infer one from the other.

OpenID Provider Configuration supplies an issuer's endpoints,
capabilities, and key-location metadata. It does not decide whether github-app-token-broker
trusts that issuer or what credential an authenticated Subject may receive.
Likewise, the ID Token Audience (`aud`) Claim identifies the intended recipient
of the incoming token, while the token-exchange `resource`, `audience`, and
`scope` parameters describe the target and access requested for the newly
issued token.

AWS IAM OIDC federation, Google Cloud Workload Identity Federation, and Vault
JWT authentication use different configuration resource boundaries, but share
the same semantic stages: explicit issuer trust, key resolution, assertion
admission, and later authorization. github-app-token-broker retains those stages without
adopting a general-purpose identity-provider control plane.

## Decision

### One authentication boundary

`OidcIdTokenAuthenticator` is the deep boundary for authenticating incoming ID
Tokens. It owns:

- validation and indexing of OIDC Provider Registrations;
- exact issuer selection;
- OpenID Provider Configuration retrieval and validation;
- JWK Set retrieval and caching;
- signature, Issuer, Audience, algorithm, required-claim, and time validation;
- provider-specific OIDC ID Token Profile validation; and
- authentication failure classification.

The authenticator returns a Verified Subject Token containing the exact
validated Issuer Identifier and verified Claims. Signing-key and cache details
are verification evidence for diagnostics, not identity or policy inputs.
HTTP request handling, OAuth responses, request logging, Token Policy, and
GitHub credential issuance remain outside this boundary.

### Configuration ownership

Configuration is placed at the narrowest stable owner that determines its
meaning:

| Concern                                           | Owner                                              | Decision                                                                                                                                                                                                                        |
| ------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subject-token audience                            | Deployment composition                             | One exact non-empty single-line scalar identifies this deployment's logical recipient and is not derived from endpoint location or requests. Source-supported capability: a deployment may choose a URL-shaped or opaque value. |
| Trusted Issuer Identifier                         | OIDC Provider Registration                         | Each registration names one exact, case-sensitive HTTPS Issuer Identifier.                                                                                                                                                      |
| Accepted ID Token signing algorithms              | OIDC Provider Registration                         | Each provider has an independently reviewed, non-empty asymmetric algorithm allowlist. Coincidentally equal provider allowlists do not become a global policy.                                                                  |
| Token-kind constraints                            | OIDC Provider Registration's OIDC ID Token Profile | Code-owned cross-claim rules distinguish the accepted kind of ID Token after central verification.                                                                                                                              |
| Provider key location and advertised capabilities | OpenID Provider                                    | The validated OpenID Provider Configuration Response supplies `jwks_uri` and `id_token_signing_alg_values_supported`.                                                                                                           |
| Target resource and requested permissions         | Installation Access Token Request and Token Policy | Explicit token-exchange `resource` and non-empty `scope` values are required and normalized before policy evaluation; neither is inferred from subject-token Claims, policy maxima, App grants, or deployment configuration.    |
| Credential grant                                  | Token Policy                                       | Exact Issuer, verified Claims, resource, and permissions determine whether issuance is allowed.                                                                                                                                 |
| Maximum issued authority                          | GitHub App installation                            | GitHub's installation and granted permissions remain the upper bound on the installation access token.                                                                                                                          |

An OIDC Provider Registration is github-app-token-broker's application-specific trust record,
not an OpenID Provider Configuration Document or OpenID Connect Dynamic Client
Registration. It contains:

- the exact Issuer Identifier;
- the provider-local accepted ID Token signing algorithms; and
- one code-owned OIDC ID Token Profile.

It contains no audience, JWK Set URI, provider alias, claim mapping,
authorization rule, or caller-selected key source.

The service audience and provider profiles are both authentication controls but
have different owners. The deployment-owned audience establishes that every incoming ID Token
was issued for this exact logical recipient. Public routing to the source-owned `/token` operation
is a deployment concern, not an audience identity or Worker binding. A provider profile establishes that
a centrally verified token is the intended provider-specific token kind.
Profiles do not choose issuers, fetch trust material, or grant a target
credential.

### Trust sequence and issuer binding

Authentication follows this sequence:

1. Decode `iss` without trusting it.
2. Use that value only for exact lookup in the preconfigured OIDC Provider
   Registration map.
3. Reject an unknown issuer without OpenID Provider Configuration or JWK Set
   I/O.
4. Derive the OpenID Provider Configuration URL only from the registered exact
   Issuer Identifier.
5. Retrieve the Provider Configuration Response without following redirects,
   then validate it before caching or using it.
6. Require the returned metadata `issuer` to equal the registered Issuer
   Identifier exactly.
7. Require an absolute HTTPS `jwks_uri` and retrieve the JWK Set from that
   validated value without following redirects.
8. Verify the token signature and require the verified token `iss` to equal the
   same registered Issuer Identifier.
9. Validate the service Audience, provider-local algorithm policy, required
   Claims, time bounds, and the provider's OIDC ID Token Profile.
10. Pass only the resulting Verified Subject Token to Token Policy.

Issuer comparison is exact string equality without URL canonicalization or
Unicode normalization. Removing a trailing slash while constructing a request
URL never changes the registered trust identifier.

Token-supplied `jku`, `x5u`, discovery URLs, key URLs, and provider identifiers
do not select trust material. An unverified `iss` can select an already
registered entry but cannot create an issuer or authorize arbitrary outbound
I/O.

### OpenID Provider Configuration URL derivation

github-app-token-broker implements the OpenID Connect Discovery 1.0 Provider Configuration
algorithm:

1. start with the already validated exact Issuer Identifier;
2. remove one terminating slash for request construction; and
3. append `/.well-known/openid-configuration` after the issuer path.

For example, a path-bearing issuer has this shape:

```text
https://issuer.example/tenant
  -> https://issuer.example/tenant/.well-known/openid-configuration
```

This is intentionally not RFC 8414's Authorization Server Metadata
transformation. RFC 8414 inserts its well-known component between the authority
and issuer path. The algorithms are equivalent for an issuer without a path
but differ for a path-bearing issuer.

The OIDC authentication operation uses only the OpenID Connect suffix-append
algorithm. It does not try the RFC 8414 location first or as a fallback. Any
Authorization Server Metadata support is a distinct, explicitly named
operation rather than a second implicit discovery path.

### Provider Metadata and algorithm policy

A successful OpenID Provider Configuration Response is accepted only after its
status, media type, JSON shape, exact `issuer`, HTTPS `jwks_uri`, and advertised
ID Token signing algorithms are validated.

The accepted signing-algorithm intersection is formed from:

- the selected OIDC Provider Registration's local allowlist; and
- the provider's `id_token_signing_alg_values_supported` metadata.

The JWT protected-header algorithm and selected verification JWK must also be
compatible with that intersection. Provider Metadata advertises capability; it
cannot widen local policy. Verifier implementation support is only a capability
ceiling and likewise cannot authorize an algorithm for a provider.

The `jwks_uri` is allowed to use a different HTTPS origin from the Issuer
Identifier. OpenID Connect does not impose a same-origin requirement, and
Google's supported Provider Metadata delegates its JWK Set to another origin.
Accepting a cross-origin `jwks_uri` treats the authenticated issuer origin as
authoritative for that HTTPS key-location delegation.

Provider Configuration and JWK Set requests reject redirects. The originally
validated HTTPS URL is the only requested URL, so transport processing cannot
move trust-material retrieval to an unvalidated or plaintext location. A
provider that requires redirection would require a separate explicit trust
decision rather than weakening this invariant.

### Cache identity and availability

Provider Metadata and JWK Sets are separate validated caches:

- Provider Metadata is associated with the exact registered provider and
  determines the current JWK Set location and the immutable intersection of
  advertised and provider-locally accepted algorithms.
- A JWK Set resolution generation is identified by both the exact validated
  `jwks_uri` and a canonical fingerprint of the accepted signing-algorithm
  intersection.

Concurrent refreshes are coalesced only when their complete cache identity is
equal. A changed `jwks_uri` or accepted signing-algorithm intersection creates
a new generation and cannot consume, join, or replace the result of an
in-flight refresh for different metadata.

Only successfully validated responses become current cache entries. Invalid
refreshes never replace a last-known-good generation. Bounded, observable stale
use may preserve availability after a provider refresh failure; after that
bound, authentication fails as provider unavailable. Remote work, response
bodies, key counts, refresh frequency, concurrency, and stale use remain
bounded service implementation policy.

Unknown signing-key identifiers can trigger controlled JWK Set refresh for
normal key rotation. Provider Configuration refresh is not itself the ordinary
key-rotation mechanism.

### Authentication, policy, and issuance remain separate

Successful ID Token authentication does not create an authorization grant.
Token Policy receives:

- the exact issuer-qualified Verified Subject Token;
- raw verified Claims;
- one normalized Repository Resource; and
- exact requested installation-access-token permissions.

Issuer, resource, and permissions are matched structurally. CEL conditions can
inspect only verified `claims`; signing-key IDs, cache generations, request
objects, and constant token-type metadata are not CEL bindings.

Every Token Policy issuer reference must resolve to an OIDC Provider
Registration when the application is composed. The reverse is not required: a
registered provider can have no grants. Invalid or ambiguous configuration
prevents construction instead of producing a partial trust or grant set.

Installation Access Token Issuance proceeds only after an exact, deny-by-default
Token Policy match. It then asks GitHub for a token narrowed to the selected
repository and permissions. Authentication trust, policy authorization, and
GitHub's installation authority are independent, cumulative controls.

### Failure boundary

The authenticator exposes domain failures:

- `subject_token_rejected` for Client-presented invalid tokens and
  unregistered issuers;
- `provider_unavailable` when required validated Provider Metadata or a usable
  JWK Set cannot be obtained within the cache policy; and
- `internal_failure` for violated local invariants or unexpected implementation
  behavior.

The Token Endpoint maps these failures to its OAuth response contract. Client
responses do not disclose registration, Subject, policy, key, or cache detail;
structured diagnostics retain the operational evidence.

### Sole key-location trust path

All registered public providers use validated OpenID Connect discovery as the
only key-location trust path. There is no runtime direct-JWK-Set configuration
or fallback. Provider unavailability is handled through bounded last-known-good
validated state, not by silently changing the authoritative trust source.

## Consequences

- Issuer trust remains explicit, reviewable, and finite even though key
  location is provider-owned.
- Providers can move their JWK Set endpoint without a github-app-token-broker release, after
  github-app-token-broker validates refreshed Provider Metadata.
- Discovery adds remote trust documents and therefore an availability surface.
  Exact issuer validation, HTTPS-only locations, redirect rejection, bounded
  work, and validated caching constrain that surface.
- Cross-origin JWK Set delegation is supported and intentionally expands the
  set of HTTPS origins involved in authentication for a registered provider.
- Each provider can evolve its accepted algorithms and token-kind profile
  independently without changing the service audience or another provider's
  trust contract.
- The exact Issuer Identifier remains the policy identity; there is no alias
  lifecycle or normalized cross-provider identity schema.
- Provider registration can safely precede policy grants. Trusting a provider
  makes authentication possible but grants no GitHub credential.
- Provider Metadata and JWK Set outages can reject otherwise valid tokens after
  bounded stale state expires. This fail-closed behavior is preferred to a
  hidden trust-source fallback.
- Provider-specific claims remain visible to Token Policy. This keeps policy
  expressive but deliberately avoids a configurable attribute-mapping layer.

## Rejected alternatives

### Dynamic issuer discovery

Rejected because it would turn an unverified token value into outbound network
authority and a trust decision. Only exact preconfigured registrations can
initiate Provider Configuration retrieval.

### Direct JWK Set configuration or fallback

Rejected for the supported public, conforming providers. A permanent direct
mode or automatic fallback would retain two authoritative trust paths and make
outages silently change security semantics. A concrete private or
non-conforming issuer is required before the registration interface is widened.

### RFC 8414 fallback

Rejected because this operation retrieves OpenID Provider Configuration for ID
Token authentication. Trying the different Authorization Server Metadata path
would create an undocumented second discovery algorithm.

### Same-origin `jwks_uri`

Rejected because OpenID Connect permits an HTTPS JWK Set on another origin and
supported Google metadata relies on that delegation.

### Global signing-algorithm policy

Rejected because an accepted algorithm is part of each issuer's trust contract.
A shared implementation capability set does not imply that every provider is
authorized to use every implemented algorithm.

### Provider-local audiences

Rejected because every registered provider supplies subject tokens to the same
exact configured Subject-Token Audience, which may be URL-shaped or opaque.
Repeating the service audience per provider permits drift without representing
provider variation.

### Client-selected provider or provider alias

Rejected because the signed exact Issuer Identifier already selects a
preconfigured registration and is the policy trust identity. A second
identifier introduces ambiguity and lifecycle without removing issuer checks.

### Generic provider configuration, attribute mapping, or provider CEL

Rejected because github-app-token-broker integrates reviewed, code-owned provider profiles
rather than operating a tenant-facing identity-provider control plane. Generic
mapping and admission languages would add schema, validation, and identity
lifecycle semantics without improving the trust decision.

### Merged authentication and Token Policy

Rejected because accepting an identity is not authority to issue a GitHub
credential. Provider admission, service Audience validation, grant policy, and
the GitHub App installation remain separate controls.

### Authorization by verification diagnostics

Rejected because signing-key IDs and cache generations are issuer-controlled
operational evidence, while the subject-token type is constant for this
service. None is a stable authorization attribute.

## References

- [OAuth 2.0 roles and Token Endpoint — RFC 6749 §§1.1 and 3.2](https://www.rfc-editor.org/rfc/rfc6749.html)
- [OAuth 2.0 Token Exchange — RFC 8693](https://www.rfc-editor.org/rfc/rfc8693.html)
- [Resource Indicators for OAuth 2.0 — RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html)
- [JSON Web Token Audience and Issuer Claims — RFC 7519 §4.1](https://www.rfc-editor.org/rfc/rfc7519.html#section-4.1)
- [JSON Web Key and JWK Set — RFC 7517](https://www.rfc-editor.org/rfc/rfc7517.html)
- [JSON Web Token Best Current Practices — RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html)
- [OpenID Connect Core 1.0, terminology and ID Token validation](https://openid.net/specs/openid-connect-core-1_0.html)
- [OpenID Connect Discovery 1.0, Provider Metadata and Provider Configuration](https://openid.net/specs/openid-connect-discovery-1_0.html)
- [OAuth 2.0 Authorization Server Metadata — RFC 8414](https://www.rfc-editor.org/rfc/rfc8414.html)
- [AWS IAM OIDC federation](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html)
- [Google Cloud Workload Identity Federation](https://cloud.google.com/iam/docs/workload-identity-federation)
- [Google Cloud WIF provider resource](https://cloud.google.com/iam/docs/reference/rest/v1/projects.locations.workloadIdentityPools.providers)
- [GitHub Actions OpenID Connect](https://docs.github.com/en/actions/reference/security/oidc)
- [Google OpenID Connect discovery and ID Token validation](https://developers.google.com/identity/openid-connect/openid-connect)
- [Fly.io OpenID Connect](https://fly.io/docs/security/openid-connect/)
- [Vault JWT/OIDC authentication](https://developer.hashicorp.com/vault/docs/auth/jwt)
