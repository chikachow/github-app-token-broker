# Multiple GitHub Apps

Decision status: Accepted.

A broker deployment may serve several explicitly configured GitHub Apps. The
canonical `POST /github/apps/{app_slug}/token` path selects one catalogue entry;
the request still independently supplies its repository and permissions. There
is no default app, body selector, or broker-owned convenience alias. An older
server ignores unknown form extensions, so a distinct path also prevents a new
selector from silently issuing through its original singleton app.

The reviewed TypeScript catalogue binds an exact slug to a GitHub client ID,
accepted Subject-Token Audiences, and a separate private-key binding. The client
ID is the App JWT issuer and the explicit `githubAppClientId` in every complete
Permit Statement. It does not replace GitHub's numeric App ID in metadata
responses. Construction snapshots configuration, rejects duplicate identities
and unresolved policy references, and performs no secret or network I/O. A
slug rename is an explicit routing change; no live GitHub lookup or alias
resolution changes security configuration.

Policy remains one global authoring inventory of independently complete Permit
Statements. App identity is explicit rather than inherited from an enclosing
group. The runtime partitions statements by client ID, and policy evaluation
also requires that client ID before determining target support or composing
permissions. A statement for another app cannot grant authority or change the
selected app's denial classification.

Each app explicitly accepts a non-empty list of scalar audience values. This
supports a common logical broker audience and app-specific vanity audiences
without inferring trust from public URLs. A token still contains exactly one
scalar `aud`; array audiences remain unsupported. Common-audience tokens may
be presented to several apps, but app-specific policy must independently permit
each issuance. Audience-bound authentication capabilities share only the
issuer-owned discovery, key, and refresh state; audience validation precedes
provider profiles and authorization.

The selected private key is resolved only after authentication, authorization,
and mandatory pre-mint acknowledgement. Issuance observations include the
selected client ID. Existing fixed-origin I/O, response bounds, failure mapping,
and post-mint acknowledgement/revocation semantics continue to apply. Separate
deployments remain the appropriate boundary for independent operators or key
custody; one catalogue is not process isolation.

The read-only RPC retains its four methods. A deployment constructs its named
entrypoint from the catalogue, and each service binding sets a fixed
`props.githubAppClientId`. Several bindings may select different apps, but a
method call cannot broaden a binding's authority. There is no implicit selector
for older bindings. Missing or invalid selectors retain the sanitized
configuration-error category.

Convenience forwarding belongs outside the broker source and deployment. Its
operator is trusted with the incoming identity token and outgoing access token,
must preserve admission identity, and must avoid caching, redirects, and
automatic retries. Concrete inventory, consumer changes, cutover order, and
rollback remain deployment-owned. This decision replaces the former one-app
deployment assumption without broadening any existing production grant.

References: [GitHub App JWT authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app),
[Cloudflare binding props](https://developers.cloudflare.com/workers/runtime-apis/context/#props),
and the [service contract](../service-contract.md).
