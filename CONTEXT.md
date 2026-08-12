# github-app-token-broker

github-app-token-broker is the maintainer's hosted automation application. It lets trusted automation workloads obtain GitHub App installation access tokens narrowed to one selected repository and the Requested Permissions without exposing the GitHub App private key outside Cloudflare. Requested permission keys may include GitHub organization- or account-level permissions; repository selection and permission narrowing are independent controls.

## Language

**Token Exchange Client**:
The OAuth Client that sends a token exchange request to **github-app-token-broker**; it is not necessarily the Subject represented by the request's ID Token.
_Avoid_: Authenticated Caller, Subject, User, human, consumer

**Fly Machine Identity**:
The organization, Fly App, and Machine identity represented by the Claims in a Fly OIDC token.
_Avoid_: Principal, VM identity, caller-supplied Machine metadata

**Fly Organization Slug**:
The provider-defined slug used in a Fly organization's **OIDC Issuer Identifier** and token Claims.
_Avoid_: Organization ID, tenant ID, authorization boundary

**Google Service Account Identity**:
The Google service account identity represented by a service account ID Token issued by the Google Cloud IAM authorization server.
_Avoid_: Principal, service account email as the primary key, downloaded service account key

**Verified Subject Token**:
The validated representation of an RFC 8693 subject token after its OpenID Connect ID Token has been accepted through an **OIDC Provider Registration**. It represents the authenticated Subject, not the **Token Exchange Client** or serialized token.
_Avoid_: Authenticated Client, Principal, raw JWT, unverified subject

**OIDC Verification Evidence**:
Audit facts describing how a **Verified Subject Token** was authenticated.
_Avoid_: Subject Token Claims, authorization attribute, provider registration

**Subject Token Claims**:
The verified Claims carried by a **Verified Subject Token**, describing identity and context asserted by an **OpenID Provider**. Only `sub` is the OIDC **Subject Identifier**; contextual Claims such as `repository` are not subject identity.
_Avoid_: Serialized subject token, derived principal fields, Client-provided attributes, subject identity for contextual Claims

**Installation Access Token Issuance**:
The exchange of a **Verified Subject Token** for a short-lived **Installation Access Token** under **Token Issuance Policy**.
_Avoid_: github-app-token-broker itself, app login

**Installation Access Token Request**:
The normalized request for one **Installation Access Token**, containing one explicitly requested **Repository Resource** and the GitHub App permissions derived from one explicitly supplied non-empty scope.
_Avoid_: Profile, grant, target selector, raw form values, broker default permissions

**Requested Permissions**:
The canonical permission map derived from the explicit scope of one **Installation Access Token Request**.
_Avoid_: Inferred permissions, broker or deployment defaults, raw scope string, GitHub `permissions` request object

**Repository Resource**:
A canonical GitHub API repository URI in the form `https://api.github.com/repos/{owner}/{repo}`.
_Avoid_: `owner/repo` shorthand, GitHub HTML URL, workflow endpoint URL

**Repository Resource Constraint**:
A selector for one exact **Repository Resource** within a **Permit Statement**.
_Avoid_: Repository Resource, arbitrary URI matcher, subject-token repository Claim

**Requested Repository Owner**:
The owner segment of the normalized **Repository Resource** authorized by **Token Issuance Policy**; GitHub installation resolution must return an installation account with the same owner login, case-insensitively, before minting.
_Avoid_: redirected owner, installation ID as owner identity, repository basename as owner identity

**GitHub App Installation**:
An installation of a GitHub App on a user, organization, or enterprise account, with repository selection configured independently where applicable.
_Avoid_: App session, app login

**Installation Access Token**:
A short-lived GitHub App token issued through one **GitHub App Installation**, narrowed by this service to one selected **Repository Resource** and the **Requested Permissions**.
_Avoid_: PAT, app JWT, repository secret

**Token Issuance Policy**:
The closed set of **Permit Statements** that determines whether **Installation Access Token Issuance** is permitted for a **Verified Subject Token** and an **Installation Access Token Request**.
_Avoid_: Ordered rules, first-match policy, caller-defined policy, generic expression language

**Permit Statement**:
One complete positive authorization declaration containing an **OIDC Subject Token Constraint**, a **Repository Resource Constraint**, and a non-empty permission map. It has no denial effect and shares no implicit fields with another statement.
_Avoid_: Partial rule, inherited default, deny statement

**OIDC Subject Token Constraint**:
An **OIDC Issuer Identifier** and a collection of **Claim Predicates** selecting acceptable **Subject Token Claims**.
_Avoid_: Authentication profile, claim mapping, unverified JWT inspection

**Claim Predicate**:
A typed condition over one Claim in **Subject Token Claims**.
_Avoid_: Generic expression, Claim mapping, unverified Claim test

**Effective Permissions**:
The pointwise maximum permission map contributed by applicable **Permit Statements**, ordered `omitted < read < write < admin`.
_Avoid_: First matching statement, whole-map equality, GitHub installation permissions

**Token Exchange Endpoint**:
The github-app-token-broker Token Endpoint that accepts an ID Token as the RFC 8693 subject token and returns an **Installation Access Token**.
_Avoid_: Installation collection endpoint, raw GitHub passthrough

**Subject-Token Audience**:
The deployment-owned exact non-empty single-line scalar that identifies the logical recipient of incoming ID Tokens. A deployment may choose a URL-shaped or opaque value. It is distinct from the hosted **Token Exchange Endpoint** location and is never derived from request-controlled data or from that endpoint.
_Avoid_: request host, inferred endpoint identity, client-selected audience

**OpenID Provider**:
An external OpenID Connect authority that issues ID Tokens and publishes configuration describing its issuer and verification keys.
_Avoid_: OIDC Provider Registration, github-app-token-broker, token caller

**OIDC Issuer Identifier**:
The exact, case-sensitive HTTPS identifier asserted by an **OpenID Provider** in **OpenID Provider Metadata** and ID Token `iss` Claims.
_Avoid_: Provider alias, discovery URL, JWK Set URI

**OIDC Provider Registration**:
A github-app-token-broker trust decision for one **OIDC Issuer Identifier**, its accepted ID Token signing algorithms, and its **OIDC ID Token Profile** selection.
_Avoid_: Trusted OIDC Issuer, arbitrary identity provider, provider alias

**OIDC ID Token Profile**:
Application-specific rules distinguishing an accepted kind of ID Token for one **OIDC Provider Registration** after central OpenID Connect validation.
_Avoid_: Token Issuance Policy, claim mapping, provider configuration

**OpenID Provider Configuration Document**:
The JSON document returned by an OpenID Provider Configuration Response and containing a subset of **OpenID Provider Metadata**.
_Avoid_: OIDC Provider Registration, Token Issuance Policy, Client-supplied metadata

**OpenID Provider Metadata**:
The standards-defined values describing an **OpenID Provider**.
_Avoid_: OIDC Provider Registration, raw Configuration Response, Token Issuance Policy

**OIDC ID Token Authenticator**:
The authentication capability that turns an ID Token accepted through an **OIDC Provider Registration** into a **Verified Subject Token**.
_Avoid_: OpenID Federation trust-chain implementation, Token Issuance Policy, dynamic issuer discovery

**JWK Set Cache**:
A bounded cache of verification keys associated with an **OIDC Provider Registration**.
_Avoid_: Permanent key store, token cache, Client-controlled key source
