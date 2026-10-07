# Multiple GitHub Apps

Decision status: Accepted.

Related workloads may use separate GitHub Apps to keep their GitHub credentials
and granted capabilities separate while sharing one broker deployment. This
reduces deployment coordination, but shares operators, key custody, admission
capacity, and availability. Separate deployments remain the appropriate boundary
when those requirements differ.

The canonical `POST /github/apps/{app_slug}/token` path selects an explicitly
configured App. There is no default App or body selector. A distinct path makes
selection visible before authentication and avoids silent fallback to the
singleton App on older servers that ignore unknown form extensions. Slugs are
reviewed configuration; a GitHub rename requires an explicit endpoint migration
rather than a live lookup changing routing.

GitHub's client ID identifies the App in credentials and every complete Permit
Statement. GitHub recommends this identifier for App JWT authentication; numeric
App IDs remain metadata. Policy stays one authoring inventory of independent
statements, with explicit App identity rather than identity inherited from an
enclosing group. Evaluation considers only the selected App's statements, so
another App cannot grant authority or change its denial classification.

Each App explicitly accepts a list of scalar audiences. This supports common
broker audiences and App-specific audiences without deriving trust from request
URLs. Audience acceptance authenticates a token for the selected App; that
App's policy must independently authorize issuance. Tokens containing array
audiences remain unsupported. Audience-bound authenticators share issuer-owned
verification state so adding Apps or rebinding credentials does not multiply
issuer refreshes or reset backoff.

The read-only RPC selects an App through fixed service-binding
`props.githubAppClientId`, keeping selection outside method arguments. Several
bindings may select different Apps, but callers cannot broaden a binding's scope
by changing a method call. Existing bindings must acquire an explicit selector;
there is no compatibility default.

Convenience forwarding and migration sequencing are deployment-owned. The
broker has no `/token` alias: a proxy operator that retains that URL is trusted
with both the incoming identity token and the returned access token. The
[deployment guide](../deployment.md) defines the forwarding requirements.

The [service contract](../service-contract.md) owns validation, public behavior,
and security boundaries. The [implementation guide](../implementation.md#token-exchange-composition)
owns runtime composition and credential-binding lifetimes.

## Consumer migration

- Replace the top-level `githubApp` and `subjectTokenAudience` arguments to
  `createGitHubAppTokenExchange` with `githubApps`; retain `composition`. Each
  App contains `slug`, `clientId`, `subjectTokenAudiences`, and `privateKey`.
  Obtain the GitHub-issued client ID; the old numeric `appId` is not a client ID.
- Add the catalogue to `createTokenExchangeWorker` alongside registrations and
  policy. Worker App records use `privateKeyBinding` instead of `privateKey`.
  Remove `GITHUB_APP_ID` and `TOKEN_BROKER_AUDIENCE` runtime overrides; retain
  separate key bindings. The Fastify plugin still takes `tokenExchange`, now a
  `GitHubAppTokenExchangeHandler` with a `tokenEndpointPaths` inventory.
- Add `githubAppClientId` to every Permit Statement while preserving its subject,
  repository, and permission constraints.
- Move direct callers to `/github/apps/{app_slug}/token`. A deployment may retain
  `/token` through a trusted external forwarder; an HTTP redirect is not a safe
  substitute for forwarding an exchange.
- Replace the direct RPC class import with
  `createGitHubAppInformationEntrypoint(catalogue)` and set the static App selector
  on every consumer binding. Missing selectors have no default.
- Accept the additive `github_app.client_id` observation field. Run the
  [deployment preflight](../deployment.md#external-cloudflare-worker-deployment-contract)
  for App identity, audience, RPC, and least-privilege issuance. The deployment
  and infrastructure owners coordinate versions, routing, and rollback.

References: [GitHub App JWT authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app),
and [Cloudflare binding props](https://developers.cloudflare.com/workers/runtime-apis/context/#props).
