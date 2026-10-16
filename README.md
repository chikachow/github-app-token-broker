# github-app-token-broker

`github-app-token-broker` is a narrowly scoped Security Token Service for trusted automation workloads. It authenticates OpenID Connect ID Tokens from configured issuers and performs Installation Access Token Issuance only when Token Issuance Policy permits the resulting Verified Subject Token and Installation Access Token Request.

The only public service route is `POST /github/apps/{app_slug}/token`. The route selects one configured GitHub App; it does not grant authority. The service has no webhook receiver, deployment trigger endpoint, or client-controlled issuer configuration.

The runtime-neutral Token Exchange module is available through Cloudflare Worker
and Node 24/Fastify 5 adapters. Deployments supply a reviewed App catalogue, OIDC
Provider Registrations, and app-qualified Token Issuance Policy; private keys
remain runtime secrets. See the [implementation guide](docs/implementation.md)
for the package map and the [multi-App decision](docs/decisions/multiple-github-apps.md)
for isolation and audience ownership.

## `POST /github/apps/{app_slug}/token`

The endpoint implements the repository's RFC 8693 profile using `application/x-www-form-urlencoded` requests:

```http
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
requested_token_type=urn:ietf:params:oauth:token-type:access_token
resource=https://api.github.com/repos/{owner}/{repo}
subject_token=<openid-connect-id-token>
subject_token_type=urn:ietf:params:oauth:token-type:id_token
scope=contents:read
```

The standards-defined access-token identifier is canonical for new Clients. The
deprecated `urn:chikachow:github-app-installation-access-token` request value
remains accepted for compatibility with pinned action releases; the response
echoes whichever supported identifier the Client requested in
`issued_token_type`.

Authentication does not grant authorization. The selected App's Permit Statements
must cover the requested repository and permissions, within that App's installation
grants. The broker never infers issuer trust, audience, repository, or permissions
from the request location.

The [service contract](docs/service-contract.md) owns request validation, responses,
errors, and security semantics. The [deployment guide](docs/deployment.md) shows
Worker and Fastify composition, key bindings, and the trusted read-only RPC.
Use the [consumer migration](docs/decisions/multiple-github-apps.md#consumer-migration)
when upgrading a singleton deployment.

## Local development

Use Node 24 and install the [pinned pnpm version](CONTRIBUTING.md#dependency-tooling):

```bash
fnm exec --using=24 pnpm install --frozen-lockfile
fnm exec --using=24 pnpm run check
```

The source Worker has an empty app catalogue and returns `404` for every HTTP route. It needs no App credentials. The development command expects a `.dev.vars` file; create an empty one if needed and run the generic template:

```bash
touch .dev.vars
fnm exec --using=24 pnpm run dev
```

Use an external deployment-owned entrypoint to configure app identities, audiences, policy, and matching private-key binding names for real exchanges. The [container suite](test/integration/README.md) provides a complete synthetic deployment. `.dev.vars.example` illustrates an optional key binding for a custom local composition.

Do not commit keys, `.dev.vars`, `.env`, `.wrangler/`, `.local-secrets/`, or private deployment overlays.

## Deployment boundaries

This public repository does not deploy the service. A deployment system outside
this repository must pin a reviewed source revision, run the source checks,
supply deployment-owned configuration and secrets, deploy the selected host,
and verify `POST /github/apps/{app_slug}/token`. A Cloudflare deployment also constructs and tests
`GitHubAppInformationEntrypoint` when providing the internal service-binding RPC;
a Node deployment composes the runtime-neutral handler into its Fastify host.

## External references

- [RFC 8693: OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693)
- [OpenID Connect Core 1.0: ID Token validation](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)
- [Fly.io OpenID Connect](https://fly.io/docs/security/openid-connect/)
- [Fly Machines API Tokens resource](https://fly.io/docs/machines/api/tokens-resource/)
- [GitHub Actions OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect)
- [GitHub App installation access tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
