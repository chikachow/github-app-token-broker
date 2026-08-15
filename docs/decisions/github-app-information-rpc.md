# GitHub App Information RPC

## Status

Decision status: Accepted.

## Context

github-app-token-broker currently exposes its token exchange as HTTP. Trusted
Workers also need selected metadata about the one configured GitHub App and its
GitHub App Installations. GitHub exposes that metadata through App-JWT
endpoints, but installation-wide repository enumeration is a different
authentication boundary: the repository-list endpoint is intended to use a
GitHub App installation access token.

The interface must therefore provide useful app-level discovery without
turning the broker into a public GitHub proxy, introducing a second App
selector, or minting an installation token as an implementation detail of a
read operation.

## Decision

Add one named Cloudflare `WorkerEntrypoint`,
`GitHubAppInformationEntrypoint`, to the existing Worker. A consumer reaches
it only through an explicitly configured trusted service binding; it is not an
HTTP endpoint. The entrypoint exposes only read-only methods and uses the
deployment's one configured GitHub App ID and private key to create an App JWT.

The runtime-neutral implementation lives in
`packages/github/src/app-information.ts`. The Worker entrypoint is a thin
adapter around that implementation. The v1 interface is:

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

The method-to-endpoint mapping is deliberately direct:

| RPC method                  | GitHub endpoint                            | Authentication |
| --------------------------- | ------------------------------------------ | -------------- |
| `getApp`                    | `GET /app`                                 | App JWT        |
| `listInstallations`         | `GET /app/installations`                   | App JWT        |
| `getInstallation`           | `GET /app/installations/{installation_id}` | App JWT        |
| `getRepositoryInstallation` | `GET /repos/{owner}/{repo}/installation`   | App JWT        |

Inputs use GitHub's request names, including `installation_id` and
`per_page`. `page` is positive, `per_page` is between 1 and 100, and the
implementation passes `since` and `outdated` strings, including exact empty
values, through without inventing local semantics. Installation IDs must be
positive integers. Repository owners and names must be single path segments;
the implementation constructs and encodes the GitHub URL rather than accepting
a caller-supplied URL.

Successful values preserve GitHub's field names, nesting, arrays, and list
response shape. `listInstallations` returns GitHub's array directly and does
not auto-paginate or wrap it in a local result object. The response schemas
accept GitHub's user, enterprise, and nullable installation-account variants,
retain documented fields, and pass through additive upstream fields. Successful
App and single-installation documents retain the existing 64 KiB bound. GitHub
currently documents `repository_selection` values `all` and `selected`.
Because GitHub treats added enum values as additive, future non-empty values
pass through unchanged. A `listInstallations` page has a separate 1 MiB bound
so GitHub's documented `per_page=100` response can be represented while
upstream memory use remains bounded.

The implementation performs a live GitHub request to the fixed
`https://api.github.com` destination for every call. One broker-owned 10-second
deadline spans receipt of response headers and the complete bounded response
body. Redirect responses are rejected before any follow-up request. It does not
cache metadata, mint an installation token, enumerate repositories, mutate an
installation, or expose GitHub response bodies through a public HTTP route.
Trusted consumers own polling cadence and concurrency; GitHub rate-limit
responses remain `GitHubAppUnavailableError`.

### Errors

Only stable error names and sanitized messages are part of the RPC contract:

- `GitHubAppNotFoundError`: a 404 from `getInstallation` or
  `getRepositoryInstallation`;
- `GitHubAppUnavailableError`: transport failure, including broker-deadline
  expiry, rate limit, or GitHub 503;
- `GitHubAppUpstreamError`: another GitHub failure or malformed successful
  response;
- `GitHubAppConfigurationError`: invalid service-owned App configuration,
  including GitHub rejecting the App JWT or credentials with HTTP 401;
- `GitHubAppInputError`: invalid RPC input; and
- `GitHubAppInternalError`: another sanitized local implementation failure.

The RPC does not depend on custom error properties such as HTTP status,
`cause`, or rate-limit flags surviving the service-binding boundary. It does
not return GitHub error bodies, credentials, or installation access tokens.

## Rationale

- Cloudflare service-binding RPC is an internal Worker-to-Worker capability
  surface. A named entrypoint gives the binding exactly the read methods it is
  authorized to call without adding a public URL or an HTTP protocol.
- The four endpoints are the app-level metadata operations that use an App
  JWT. They cover app identity, installation discovery, installation lookup,
  and repository-to-installation lookup.
- GitHub's `GET /installation/repositories` endpoint is intentionally absent:
  the intended installation-wide view requires an Installation Access Token.
  Adding it later should be a separate decision about token acquisition,
  lifetime, repository exposure, and pagination.
- GitHub-shaped results keep the seam shallow for callers and avoid local
  response envelopes, renamed fields, and hidden auto-pagination.
- The runtime-neutral module keeps authentication, URL construction, bounded
  response reading, and schema validation independently testable from the
  Cloudflare adapter.

## Consequences

- A trusted Worker can inspect app and installation metadata without receiving
  the private key or an installation token.
- The caller must handle GitHub pagination itself and must treat metadata as a
  live, eventually changing view.
- The interface exposes the links and metadata GitHub includes in installation
  objects, including links that are not themselves callable through this RPC.
- Adding repository enumeration, installation-token operations, user access
  token operations, pending installation requests, or mutation methods requires
  a new review rather than silently expanding this capability.

## References

- [GitHub REST API endpoints for GitHub Apps](https://docs.github.com/en/rest/apps/apps)
- [GitHub REST API endpoints for GitHub App installations](https://docs.github.com/en/rest/apps/installations)
- [Cloudflare service-binding RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/)
- [Cloudflare RPC visibility and security model](https://developers.cloudflare.com/workers/runtime-apis/rpc/visibility/)
- [Cloudflare RPC TypeScript support](https://developers.cloudflare.com/workers/runtime-apis/rpc/typescript/)
- [Cloudflare RPC error handling](https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/)
