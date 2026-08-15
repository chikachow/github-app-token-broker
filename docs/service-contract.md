# github-app-token-broker Service Contract

This document describes the public interface, security boundaries, and externally observable behaviour implemented by github-app-token-broker.

## Public Endpoints

| Route    | Method | Purpose                                      | Success response          |
| -------- | ------ | -------------------------------------------- | ------------------------- |
| `/token` | `POST` | Accept OpenID Connect ID Tokens for exchange | OAuth token response JSON |

Unknown routes return `404` problem details. Unsupported methods on `/token` return OAuth error JSON with `400 {"error":"invalid_request"}`.

## Internal GitHub App Information RPC

The Worker also exports a named `GitHubAppInformationEntrypoint` for an
explicitly configured Cloudflare Worker service binding. This is an internal
Worker-to-Worker capability, not a public HTTP endpoint. The binding is the
caller authorization boundary; callers do not provide an App selector, App
JWT, private key, or Installation Access Token.

The v1 methods are:

```ts
interface GitHubAppInformation {
  getApp(): Promise<GitHubApp>;
  listInstallations(input?: {
    page?: number;
    per_page?: number;
    since?: string;
    outdated?: string;
  }): Promise<GitHubAppInstallation[]>;
  getInstallation(input: { installation_id: number }): Promise<GitHubAppInstallation>;
  getRepositoryInstallation(input: { owner: string; repo: string }): Promise<GitHubAppInstallation>;
}
```

These methods map to GitHub `GET /app`, `GET /app/installations`,
`GET /app/installations/{installation_id}`, and
`GET /repos/{owner}/{repo}/installation`, respectively. Successful values
retain GitHub's field names, nesting, and pagination response shape. The list
method returns one upstream page and does not auto-paginate. `per_page` is
bounded to 100; `since` and `outdated` are passed through as strings, including
exact empty values; installation IDs are positive integers; and repository
inputs are validated path components inside the service. Successful App and
single-installation documents are bounded to `64 KiB`; installation-list pages
are bounded to `1 MiB` so a documented 100-item GitHub page can be returned.
GitHub currently documents `repository_selection` values `all` and `selected`.
Because GitHub treats added enum values as additive, future non-empty values
pass through unchanged.

The RPC uses the configured App JWT and performs a live request to the fixed
`https://api.github.com` destination for each call. One broker-owned 10-second
deadline spans receipt of response headers and consumption of the complete
bounded response body.
It does not list repositories for an installation, because that GitHub
operation requires an Installation Access Token for the intended private
installation view. It also does not mint tokens or expose mutation methods.
Trusted consumers own polling cadence and concurrency; GitHub rate-limit
responses, broker-deadline expiry, and other transport failures remain
`GitHubAppUnavailableError`.

RPC failures use stable error names: `GitHubAppNotFoundError`,
`GitHubAppUnavailableError`, `GitHubAppUpstreamError`,
`GitHubAppConfigurationError`, `GitHubAppInputError`, and
`GitHubAppInternalError`. The configuration category covers an invalid App ID,
private key, or GitHub rejecting the service-owned App JWT or credentials with
HTTP `401`; the internal category covers other sanitized
local implementation failures. GitHub error bodies, credentials, tokens, and
custom HTTP-status properties are not part of the RPC contract. See the
[GitHub App Information RPC decision](decisions/github-app-information-rpc.md)
and [research findings](research/github-app-information.md).

## Token Exchange

### Request and response behaviour

`POST /token` accepts `application/x-www-form-urlencoded` token exchange input aligned with [RFC 8693](https://www.rfc-editor.org/rfc/rfc8693):

- `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`
- `subject_token=<openid-connect-id-token>`
- `subject_token_type=urn:ietf:params:oauth:token-type:id_token`
- `requested_token_type=urn:ietf:params:oauth:token-type:access_token`
- `resource=<canonical-github-repository-api-uri>`
- `scope=<github-permission-request-list>`

Request bodies are bounded to `64 KiB`.

For this interaction, the automation workload is the OAuth Client, github-app-token-broker is
the Authorization Server exposing its Token Endpoint, and the GitHub API is the
Resource Server for the issued GitHub App installation access token. github-app-token-broker
does not authenticate the Client. The ID Token in `subject_token` represents
the token's Subject, which is not assumed to be the Client.

Requests are rate limited by the `TOKEN_EXCHANGE_RATE_LIMIT` Cloudflare binding before the body is parsed. `CF-Connecting-IP` is the only request-derived rate-limit key; when it is absent, the broker uses the constant `unknown`. `X-Forwarded-For` does not supply rate-limit identity.

`resource` must be exactly one canonical GitHub repository API URI:

```text
https://api.github.com/repos/{owner}/{repo}
```

Exactly empty `resource` occurrences are treated as omitted under [OAuth Token Endpoint parameter rules](https://www.rfc-editor.org/rfc/rfc6749#section-3.2). After omission, exactly one effective value is required. No effective resource or multiple effective resources are rejected as `invalid_target`, consistent with RFC 8693's [repeatable `resource` parameter](https://www.rfc-editor.org/rfc/rfc8693#section-2.1) and [`invalid_target` response](https://www.rfc-editor.org/rfc/rfc8693#section-2.2.2). Repository shorthand, GitHub HTML URLs, endpoint URLs, query strings, fragments, userinfo, encoded slashes, dot segments, leading or trailing whitespace, arrays, and malformed resources are also rejected. github-app-token-broker never infers the target Repository Resource from Subject Token Claims. Target syntax is normalized before subject-token authentication.

`scope` is required and is a single-ASCII-space-delimited list of GitHub App permission requests in the form `<permission-name>:<level>`. A permission name is any non-empty ASCII OAuth scope-token component that contains no colon; github-app-token-broker does not maintain a GitHub permission-name catalogue. The supported levels are `read`, `write`, and `admin`, ordered `read < write < admin`. GitHub remains authoritative for whether a permission name accepts a particular level.

Scope order is not significant, and repeated identical scope tokens are normalized once. Two tokens for the same permission name at different levels are ambiguous and rejected. The resulting canonical map is the Requested Permissions. Leading whitespace, trailing whitespace, repeated spaces, tabs, newlines, multiple or missing colons, non-scope-token characters, and levels outside `read`, `write`, and `admin` are rejected. An omitted `scope`, exactly empty `scope=`, or whitespace-only field is rejected with `400 {"error":"invalid_scope"}`. The broker has no default Requested Permissions.

Normalization creates one immutable Installation Access Token Request. Its
Repository Resource and Requested Permissions are canonical owned values; its
resource URI and response scope are derived from those values rather than
stored as independently mutable request state.

An empty `scope` is not a no-permissions request and is never translated to an empty GitHub permissions object. The broker does not infer permissions from the Repository Resource, Subject Token Claims, Token Issuance Policy maxima, GitHub App grants, or deployment configuration. Source workflows either use the pinned action's least-privilege default scope or explicitly override it. Caller behavior does not make `scope` optional at the Token Exchange Endpoint.

The OpenID Connect ID Token supplied as the RFC 8693 subject token must have non-empty Issuer Identifier (`iss`), Audience (`aud`), and Subject (`sub`) Claims plus numeric Expiration Time (`exp`) and Issued At (`iat`) Claims. github-app-token-broker accepts only the ID Token subject-token-type identifier, verifies the configured Issuer Identifier and expiration, and does not impose a separate maximum token age based on `iat`. The ID Token must have the single Subject-Token Audience value from the deployment-owned `TOKEN_BROKER_AUDIENCE` binding. The binding is parsed and validated into an exact non-empty, non-whitespace, single-line domain value and may be URL-shaped or opaque. Missing or plural token audiences, and every scalar value that does not exactly equal the configured value, receive `400 {"error":"invalid_request"}`. One authentication operation captures one value from the injected clock and uses it for JOSE time validation and cache decisions. After central verification, the authenticator copies and recursively freezes the verified JSON Claims. A non-null OIDC ID Token Profile validates that immutable snapshot as the provider-specific token kind; an explicit `null` profile means central validation is sufficient. Token Issuance Policy receives the same immutable snapshot only after profile admission, so profile validation and policy authorization remain separate decisions.

github-app-token-broker does not support RFC 8693 `audience`, `actor_token`, or `actor_token_type` form parameters. Non-empty `audience` parameters are rejected with `invalid_target` because this profile uses `resource` for the issued token target and service-owned GitHub App credentials. Actor-token parameters are rejected as malformed for this profile with `invalid_request`.

github-app-token-broker also does not support OAuth client authentication or Rich Authorization Requests at `/token`. Requests containing non-empty `client_id`, `client_secret`, `client_assertion`, `client_assertion_type`, or `authorization_details` fields are rejected with `invalid_request` rather than silently ignored. Requests containing an `Authorization` header are rejected with `401 {"error":"invalid_client"}` and a matching `WWW-Authenticate` challenge. Value-less form parameters are treated as omitted, and other unrecognized extension parameters are ignored, according to OAuth Token Endpoint rules.

The standards-defined access-token identifier is canonical for new Clients.
The deprecated `urn:chikachow:github-app-installation-access-token` literal is
also accepted as a requested-token-type compatibility alias for pinned action
releases. A successful response returns the supported identifier supplied by
the Client as `issued_token_type`. No other requested token type is accepted.

Successful ID Token verification establishes that the configured issuer signed the token for the exact deployment-owned Subject-Token Audience and establishes its Subject Token Claims; it does not authenticate the Client. The service owns the configured GitHub App credentials; `resource` names the GitHub API repository target where the issued token will be used; and Token Issuance Policy decides whether issuance is permitted for the resulting Verified Subject Token and Installation Access Token Request. Plural token audiences are rejected rather than interpreted by containment. The Worker reads the Subject-Token Audience only from `TOKEN_BROKER_AUDIENCE`; it owns no endpoint-location binding and never derives identity from the request URL, `Host`, forwarded headers, or `/token` path.

When Token Issuance Policy does not permit issuance, github-app-token-broker distinguishes the
Token Endpoint failure at the protocol boundary. An unsupported Repository Resource
receives `400 {"error":"invalid_target"}`. Requested Permissions that the
artifact's compiled Permit Statements cannot cover for a supported resource receive `400
{"error":"invalid_scope"}`. This policy rejection is distinct from GitHub
rejecting a name or level after policy approval. When both the resource and
Requested Permissions are supported but the Verified Subject Token is not
acceptable to policy, the response is `400 {"error":"invalid_request"}`.

Successful responses are JSON with `Cache-Control: no-store` and `Pragma: no-cache`. github-app-token-broker always returns the canonical issued `scope`, including when the request supplied the same permission set in a different order:

```json
{
  "access_token": "ghs_...",
  "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "token_type": "Bearer",
  "scope": "contents:write pull_requests:write",
  "expires_in": 3600
}
```

Token Endpoint error responses use JSON with the same no-store headers. This is
a total protocol boundary: failures from rate limiting, request-body reading,
authentication/exchange work, or response construction that do not match a
documented category are caught and sanitized to non-cacheable
`500 {"error":"server_error"}`. That final response contains no raw request
body, subject token, access token, or exception message. The
registered OAuth and token-exchange errors below follow their cited
specifications. github-app-token-broker also defines service-specific operational error
responses: its use of `server_error` and `temporarily_unavailable` at the Token
Endpoint, and the `413`, `429`, `500`, `502`, and `503` status mappings below, are
deliberate github-app-token-broker protocol extensions. They are not claimed to comply with RFC
6749 section 5.2, which normally specifies HTTP `400` for Token Endpoint error
responses, and the [IANA OAuth Extensions Error
Registry](https://www.iana.org/assignments/oauth-parameters/oauth-parameters.xhtml)
registers those two names for the authorization endpoint. Clients must
interpret the complete HTTP-status and error-code pair as this service's
contract.

Request, authentication, policy, and service-level failures map as follows:

- malformed request: `400 {"error":"invalid_request"}`
- unsupported subject-token type, including the generic JWT identifier: `400 {"error":"invalid_request"}`
- unsupported client authentication header: `401 {"error":"invalid_client"}`
- missing or unsupported requested token type: `400 {"error":"invalid_request"}`
- unsupported non-empty token-exchange `audience`: `400 {"error":"invalid_target"}`
- unsupported grant type: `400 {"error":"unsupported_grant_type"}`
- rate limit exceeded: `429 {"error":"temporarily_unavailable"}`
- body too large: `413 {"error":"invalid_request"}`
- OpenID Provider Configuration transport failure, timeout, or non-success response, or JWK Set unavailable: `503 {"error":"temporarily_unavailable"}`
- invalid OpenID Provider Configuration representation or metadata: `400 {"error":"invalid_request"}`
- missing, empty, malformed, or unsupported `resource` parameter: `400 {"error":"invalid_target"}`
- missing, empty, malformed, ambiguous, or unsupported scope: `400 {"error":"invalid_scope"}`
- Requested Permissions not covered by any Permit Statement composition for a supported Repository Resource: `400 {"error":"invalid_scope"}`
- subject token unacceptable to Token Issuance Policy for an otherwise supported Repository Resource and Requested Permissions: `400 {"error":"invalid_request"}`
- internal server failure: `500 {"error":"server_error"}`

Only rejection of an actual Client `Authorization` authentication attempt
includes `WWW-Authenticate`. Subject-token rejection, OpenID Provider
unavailability, and internal authentication failure retain their mapped OAuth
status and error body without a Client authentication challenge.

After Token Issuance Policy permits a request, issuance failures have this
complete observable mapping:

| Issuance condition                                          | HTTP status | Error code                |
| ----------------------------------------------------------- | ----------- | ------------------------- |
| missing or invalid service-owned private key                | `500`       | `server_error`            |
| request rejected with `400`                                 | `500`       | `server_error`            |
| service-owned credentials rejected with `401`               | `500`       | `server_error`            |
| validation rejected with `422`                              | `500`       | `server_error`            |
| non-rate-limit `403`                                        | `502`       | `server_error`            |
| `404`                                                       | `502`       | `server_error`            |
| rate-limit `403` or `429`                                   | `503`       | `temporarily_unavailable` |
| `503`                                                       | `503`       | `temporarily_unavailable` |
| transport failure                                           | `503`       | `temporarily_unavailable` |
| malformed, schema-invalid, or oversized successful response | `502`       | `server_error`            |
| other GitHub `5xx`                                          | `502`       | `server_error`            |
| otherwise unclassified issuance failure                     | `500`       | `server_error`            |

The [GitHub API Failure Classification
decision](decisions/github-api-failure-classification.md) records the rationale,
rate-limit evidence, and sanitization boundary behind this normative mapping.

For the small installation-resolution and installation-token documents github-app-token-broker
consumes, a successful GitHub response body is limited to `64 KiB`. A larger
upstream document is an invalid successful representation and follows the
`502` mapping above; it is not derived from a Token Exchange Client parameter.

OpenID Provider Configuration transport failures, timeouts, and non-success responses mean github-app-token-broker cannot obtain Provider Metadata and return `503 {"error":"temporarily_unavailable"}`. A successfully retrieved Provider Configuration whose representation or consumed metadata is invalid instead makes the subject token unverifiable and returns `400 {"error":"invalid_request"}`. This includes unexpected media types, oversized responses, malformed JSON or shape, an issuer mismatch, an invalid `jwks_uri`, and no intersection between the provider's advertised algorithms and the registration's accepted algorithms.

JWK Set network failures, timeouts, non-200 responses, unexpected media types, oversized responses, malformed JSON or shape, an empty or wholly incompatible JWK Set, or ambiguous provider key material mean github-app-token-broker cannot obtain a usable JWK Set and return `503 {"error":"temporarily_unavailable"}`. Every JWK consumed by the verifier must have a string `kty`; when present, `alg`, `kid`, and `use` must be strings and `key_ops` and `x5c` must be arrays of strings. Malformed member structure makes the provider JWK Set unavailable rather than silently filtering the malformed key. Cryptographic import still determines whether structurally valid key material is usable for an accepted algorithm.

Bounded last-known-good OpenID Provider Metadata or a JWK Set may be used according to documented cache controls. Responses marked [`Cache-Control: no-cache`](https://www.rfc-editor.org/rfc/rfc9111#section-5.2.2.4) require successful revalidation before reuse and are never used as stale fallback after a failed revalidation. An ID Token whose protected header names a `kid` absent from an otherwise usable JWK Set triggers one controlled refresh. If that refresh fails while the original JWK Set is still fresh and cacheable, the refresh failure remains observable in operational diagnostics but the original no-matching-key classification remains a Client-presented subject-token rejection: `400 {"error":"invalid_request"}`. A non-cacheable JWK Set cannot be reused after failed refresh. If no usable JWK Set remains, the result is provider unavailability instead.

### Supported OIDC Provider Registrations

| OpenID Provider                  | OIDC Issuer Identifier (`iss`)                | OIDC ID Token Profile                                          |
| -------------------------------- | --------------------------------------------- | -------------------------------------------------------------- |
| GitHub Actions                   | `https://token.actions.githubusercontent.com` | validates that `azp` is absent or equals the exact `aud` value |
| Google service account ID Tokens | `https://accounts.google.com`                 | validates that `azp` equals `sub`                              |

Provider packages expose these reviewed registrations for deployment composition. Their availability does not register them in an artifact or create a Permit Statement. Every request still requires the Client to supply an explicit repository `resource`.

#### GitHub Actions

GitHub Actions Clients present a [GitHub Actions OIDC token](https://docs.github.com/en/actions/concepts/security/openid-connect), which is an ID Token issued by `https://token.actions.githubusercontent.com`. An absent Authorized Party (`azp`) claim is accepted; when present, it must equal the exact deployment-owned `TOKEN_BROKER_AUDIENCE` value in `aud`. GitHub Actions Clients must provide an explicit repository `resource`; the signed `repository` Claim is verified context in the Subject Token Claims available to Token Issuance Policy and is not used to select the token target. Authentication produces a Verified Subject Token but does not create a Permit Statement.

#### Google service account ID Tokens

Google service account Clients present a [service account ID Token](https://cloud.google.com/docs/authentication/token-types#service_account_id_tokens) issued by the Google Cloud IAM authorization server with Issuer Identifier `https://accounts.google.com`. The shared verifier requires a non-empty string Subject (`sub`), and the Google service-account OIDC ID Token Profile requires the Authorized Party (`azp`) to equal that Subject. Google documents both claims as the service account unique ID for this token type; github-app-token-broker treats that identifier as an opaque string. Optional `email` and `email_verified` claims do not affect authentication.

Google Clients must provide an explicit repository `resource`; omission or `resource=` receives `invalid_target`. Authentication produces a Verified Subject Token but does not create a Permit Statement.

#### Source-supported Fly OIDC registration

The source-supported Fly provider package constructs a reviewed registration for one exact issuer in the form `https://oidc.fly.io/{organization-slug}`. The constructor accepts a canonical lowercase organization slug, restricts ID Token signatures to RS256, and selects an explicit null OIDC ID Token Profile. Central ID Token validation therefore authenticates the signed Fly Machine Identity Claims without imposing provider-specific relationships among `org_name`, `app_name`, `machine_name`, and `sub`.

A deployment composition may register that exact issuer and must independently add Permit Statements selecting every Fly Claim material to authorization. An already-compiled Worker cannot add the registration or policy at runtime. Fly documents both its [organization-specific OpenID Connect issuers and Machine identity Claims](https://fly.io/docs/security/openid-connect/) and [Machine token acquisition with a caller-selected audience](https://fly.io/docs/machines/api/tokens-resource/).

For a deployment whose `TOKEN_BROKER_AUDIENCE` is `https://broker.example`, a Fly workload requests its ID Token with that exact value in the Fly Tokens resource `aud` field; `/token` is not part of the audience:

```http
POST /v1/tokens/oidc
Content-Type: application/json

{"aud":"https://broker.example"}
```

Fly returns the serialized ID Token as the response body. The workload sends that value as this service's RFC 8693 `subject_token` and sends the broker request to the deployment's Token Exchange Endpoint. The broker still accepts it only when the built artifact contains both the exact Fly organization registration and a Permit Statement that covers the token's signed Claims, requested Repository Resource, and Requested Permissions.

### Token Issuance Policy

Installation Access Token Issuance is allowed only when the normalized request is covered by the closed, immutable set of Permit Statements compiled into the Worker artifact. Each independently complete statement contains an exact issuer, Claim Predicates over Subject Token Claims, one Repository Resource Constraint, and a non-empty permission map. A constraint selects either one exact repository or every repository owned by one owner. Missing or wrongly typed selected Claims make a statement non-applicable; evaluation never throws for verified Claim data.

The `TokenIssuancePolicy` returned by `compileTokenIssuancePolicy` is a
structural package Interface. Its compiled
`permitStatements[].resource` is a Repository Resource Constraint with `{ owner,
repository }` for an exact repository or `{ owner, repository: null }` for every
repository under that owner. Consumers discriminate owner-wide constraints with
`repository === null`.

All statements whose issuer, Claim Predicates, and Repository Resource Constraint apply contribute permissions pointwise using `omitted < read < write < admin`. One total policy evaluation returns exactly one outcome: `permitted`, `target_unsupported`, `requested_permissions_unsupported`, or `subject_token_unacceptable`. It derives protocol classification and the authorization answer in one traversal; no caller recomputes support through separate Boolean queries. Statement order is irrelevant, stronger contributed permissions cover weaker Requested Permissions, and several statements may jointly cover a request. Permission names are extensible, but every Requested Permission still requires explicit Permit Statement coverage; arbitrary names are never authorized by default. There are no deny statements, inheritance, dynamic configuration, generic expression language, matched-statement result, or contributor list.

Every policy issuer must resolve to an OIDC Provider Registration when the application is composed; the reverse is intentionally not required. The deployment-owned TypeScript entrypoint and its independent tests are authoritative for an artifact's exact inventory.

#### GitHub Actions

GitHub Actions authentication additionally requires:

- the Client presents a [GitHub Actions OIDC token](https://docs.github.com/en/actions/concepts/security/openid-connect) from `https://token.actions.githubusercontent.com`
- the signed Subject-Token Audience is the exact deployment `TOKEN_BROKER_AUDIENCE` value
- if the GitHub Actions OIDC token has an `azp` claim, that claim matches the same exact audience

After authentication, a deployment may configure a GitHub Actions Permit
Statement with zero or more Claim Predicates over signed Claims. For example,
a reviewed composition can constrain `event_name`, `ref_type`, `repository`,
`ref`, or `workflow_ref`. Every statement independently contains one Repository
Resource Constraint, which selects one exact repository or every repository
under one owner. The public source defines these capabilities, not a universal
GitHub Actions predicate set or a deployment inventory.

Claims a statement does not select, including `sub`, repository IDs, owner IDs, and actor metadata, do not affect authorization. A GitHub Actions token that fails its OIDC ID Token Profile, including an invalid `azp` claim, remains an invalid subject token and returns `400 {"error":"invalid_request"}`. Repository identity remains name-based; a repository deleted and recreated with the same owner/name can continue to match when the GitHub App installation still grants sufficient permissions.

The pinned source workflow action supplies its least-privilege default scope when no override is needed, and workflows with a different request explicitly set their scope. Direct broker Clients must likewise send their chosen non-empty scope explicitly; the broker does not own or recreate a caller default.

Contexts not covered by the compiled Permit Statements are denied.

#### Shared enforcement and issuance

The Client cannot select arbitrary GitHub Apps or repository IDs. It may name any structurally valid GitHub permission in `scope`, but Token Issuance Policy answers whether its Effective Permissions cover every Requested Permission; names are never authorized merely because they parse. If policy does not permit issuance, github-app-token-broker returns `invalid_target` when the Repository Resource is unsupported, `invalid_scope` when the resource is supported but the Requested Permissions are not, and `invalid_request` when both are supported but the Verified Subject Token is unacceptable to policy. The [GitHub App installation](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app) independently remains the upper bound on repositories and permissions.

Missing or incorrectly typed claims selected by Permit Statements authenticate as verified token data but make the Verified Subject Token unacceptable to policy for a supported target, returning `400 {"error":"invalid_request"}`. An invalid standard ID Token claim or failed non-null OIDC ID Token Profile is also an invalid subject token and returns `400 {"error":"invalid_request"}` before policy evaluation.

After policy permits issuance, the broker passes the normalized Repository Resource and Requested Permissions to one broker-owned GitHub issuance capability. That capability resolves the GitHub App credentials and App JWT once for the exchange, uses them to resolve the target installation with `GET /repos/{owner}/{repo}/installation`, and requires the returned installation account's `login` to match the requested owner case-insensitively before minting. The shared GitHub HTTP client rejects redirect responses before any follow-up request, so App credentials are never forwarded through a redirect; owner validation independently protects the repository selected by Token Issuance Policy. It then mints the final Installation Access Token with GitHub's `repositories` selector and the exact Requested Permissions. It sends no [temporary stateful-token override](https://github.blog/changelog/2026-05-15-github-app-installation-tokens-per-request-override-header/) and treats the returned token string as an opaque credential, accepting both GitHub's legacy opaque and JWT-shaped installation-token formats. It does not fetch source repository metadata or use live default-branch metadata as policy criteria. A successful GitHub lookup whose installation owner does not match the requested owner is treated as an upstream failure and returns `502 {"error":"server_error"}`. Other GitHub validation failure after policy approval, including HTTP `422` for a name or level GitHub does not accept, is a service/configuration failure and returns `500 {"error":"server_error"}` rather than `invalid_scope`.

Every GitHub request is restricted to `https://api.github.com`, rejects redirects without making a follow-up request, and has one fixed broker-owned 10-second deadline covering response headers and complete bounded body consumption. A deadline or other transport failure maps to `503 {"error":"temporarily_unavailable"}` at the Token Endpoint and `GitHubAppUnavailableError` through the GitHub App Information RPC. Operational logs distinguish the actual `error.upstream_status`, when a response was received, from the broker's classified `error.status`; a synthetic `502` is never logged as if GitHub returned `502`. After installation resolution succeeds, its ID remains available to the failure log even if the subsequent token-minting request fails.

GitHub response status alone does not establish that the Client selected an
invalid target. The complete Token Endpoint mapping above distinguishes
service-owned, upstream, and temporarily unavailable failures; none is
translated to `invalid_target`.

github-app-token-broker denies malformed `scope` values, Requested Permissions not covered by policy, and non-canonical resource forms.

### Standards and Vendor References

- [RFC 8693, Section 2.1](https://www.rfc-editor.org/rfc/rfc8693#section-2.1): token exchange request parameters, including `resource`, `audience`, `scope`, `subject_token`, `subject_token_type`, `actor_token`, `actor_token_type`, and `requested_token_type`.
- [RFC 8693, Section 2.2.1](https://www.rfc-editor.org/rfc/rfc8693#section-2.2.1): successful token exchange responses, including the requirement to return `scope` when the issued token scope differs from the requested scope.
- [RFC 8693, Section 2.2.2](https://www.rfc-editor.org/rfc/rfc8693#section-2.2.2): `invalid_target` for unsupported requested resources or audiences.
- [RFC 6749, Section 5.2](https://www.rfc-editor.org/rfc/rfc6749#section-5.2): `invalid_scope` for invalid, unknown, or excessive requested scope.
- [RFC 6749, Section 3.2](https://www.rfc-editor.org/rfc/rfc6749#section-3.2): Token Endpoint request parameter handling, including value-less parameters, duplicate parameters, unrecognized parameters, and client authentication.
- [RFC 6749, Section 3.3](https://www.rfc-editor.org/rfc/rfc6749#section-3.3): OAuth scope syntax and authorization-server-defined scope strings.
- [RFC 6749, Section 4.5](https://www.rfc-editor.org/rfc/rfc6749#section-4.5): extension grant types can define additional Token Endpoint parameters.
- [RFC 6749, Section 5.1](https://www.rfc-editor.org/rfc/rfc6749#section-5.1): successful token responses, including `scope` response semantics.
- [RFC 6749, Section 5.2](https://www.rfc-editor.org/rfc/rfc6749#section-5.2): OAuth Token Endpoint error responses, including `invalid_client` and `WWW-Authenticate` handling for authorization-header client authentication attempts.
- [RFC 6749, Section 8.2](https://www.rfc-editor.org/rfc/rfc6749#section-8.2): registration requirements for new OAuth endpoint parameters.
- [RFC 7523, Section 2.2](https://www.rfc-editor.org/rfc/rfc7523#section-2.2): JWT bearer client authentication parameters `client_assertion` and `client_assertion_type`.
- [RFC 9396](https://www.rfc-editor.org/rfc/rfc9396): Rich Authorization Requests and the `authorization_details` parameter.
- [RFC 7519, Section 4.1.3](https://www.rfc-editor.org/rfc/rfc7519#section-4.1.3): JWT `aud` claim processing and rejection when the processor is not an intended audience.
- [OpenID Connect Core 1.0, Section 3.1.3.7](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation): ID Token audience and authorized-party validation.
- [Fly.io OpenID Connect](https://fly.io/docs/security/openid-connect/): organization-specific issuers, Machine identity Claims, canonical Subject, and custom Audience.
- [Fly Machines API Tokens resource](https://fly.io/docs/machines/api/tokens-resource/): obtaining a Fly OIDC token and setting its `aud` Claim.
- [GitHub Actions OIDC reference](https://docs.github.com/en/actions/reference/security/oidc): GitHub Actions OIDC claims, including `aud`, `repository`, `repository_id`, `repository_owner_id`, and `workflow_ref`.
- [Google Cloud authentication token types](https://cloud.google.com/docs/authentication/token-types#service_account_id_tokens): service account ID Token issuer, signing, lifetime, and claim meanings.
- [Google IAM service account resource](https://cloud.google.com/iam/docs/reference/rest/v1/projects.serviceAccounts): service account unique ID.
- [Google IAM Credentials `generateIdToken`](https://cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateIdToken): service account ID Token generation, required permission, audience, delegation, and optional email claims.
- [Google IAM roles for service account authentication](https://cloud.google.com/iam/docs/service-account-permissions): direct ID Token and delegation permissions.
- [Google IAM delegated short-lived credentials](https://cloud.google.com/iam/docs/create-short-lived-credentials-delegated): delegation-chain role relationships.
- [Google Cloud: Get an ID token](https://cloud.google.com/docs/authentication/get-id-token): supported service account ID Token acquisition methods and audience selection.
- [GitHub App installation access token API](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app): GitHub installation access tokens are narrowed with `repositories` or `repository_ids` and `permissions`, subject to the app installation's grants.

## Runtime Bindings

The implementation uses these runtime bindings:

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY` Secrets Store binding or Worker secret
- `TOKEN_BROKER_AUDIENCE`
- `TOKEN_EXCHANGE_RATE_LIMIT` Cloudflare rate-limit binding

The public Wrangler configs declare binding names for local development, tests,
and dry-runs. `GITHUB_APP_ID` is a positive decimal identifier. The GitHub API
destination is fixed to `https://api.github.com` and is not a runtime binding.

## Unsupported Behaviour

github-app-token-broker does not implement:

- Installation Access Token Issuance for a Repository Resource not covered by Token Issuance Policy
- Client-supplied GitHub permissions JSON object
- Client-defined GitHub permission profiles or aliases
- multi-audience subject tokens or multi-resource token requests
- dynamic issuer discovery from untrusted tokens
- issued installation access token caching

## External References

- [RFC 8693: OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693)
- [OpenID Connect Core 1.0: ID Token validation](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)
- [Fly.io OpenID Connect](https://fly.io/docs/security/openid-connect/)
- [Fly Machines API Tokens resource](https://fly.io/docs/machines/api/tokens-resource/)
- [GitHub Actions OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect)
- [Google Cloud authentication token types](https://cloud.google.com/docs/authentication/token-types#service_account_id_tokens)
- [Google IAM service account resource](https://cloud.google.com/iam/docs/reference/rest/v1/projects.serviceAccounts)
- [Google IAM Credentials `generateIdToken`](https://cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateIdToken)
- [Google IAM roles for service account authentication](https://cloud.google.com/iam/docs/service-account-permissions)
- [Google IAM delegated short-lived credentials](https://cloud.google.com/iam/docs/create-short-lived-credentials-delegated)
- [Google Cloud: Get an ID token](https://cloud.google.com/docs/authentication/get-id-token)
- [GitHub App installation access tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
