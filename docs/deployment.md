# Deployment

This public repository owns the broker source, tests, documentation, public-safe Wrangler templates, and the source side of the release handoff. It does not own credentials, production routes, Cloudflare account identifiers, deployment overlays, or deployment execution.

## Cloudflare Worker: explicit app catalogue

`@github-app-token-broker/worker` is the sole Worker package. Its public routes are `POST /github/apps/{app_slug}/token` for configured apps. A deployment supplies a reviewed TypeScript catalogue, OIDC Provider Registrations, and app-qualified Token Issuance Policy. Empty catalogues and policies form a valid deny-all composition; they expose no app routes.

```ts
import {
  createGitHubAppInformationEntrypoint,
  createTokenExchangeWorker,
  type TokenExchangeWorkerComposition,
} from "@github-app-token-broker/worker";
import { oidcProviderRegistrations, tokenIssuancePolicy } from "./policy.ts";

export const githubApps = [
  {
    slug: "example-app",
    clientId: "Iv1.exampleApp",
    privateKeyBinding: "EXAMPLE_APP_PRIVATE_KEY",
    subjectTokenAudiences: ["https://broker.example", "https://app.example"],
  },
] as const satisfies TokenExchangeWorkerComposition["githubApps"];

export const GitHubAppInformationEntrypoint = createGitHubAppInformationEntrypoint(githubApps);
export default createTokenExchangeWorker({
  githubApps,
  oidcProviderRegistrations,
  tokenIssuancePolicy,
});
```

Every Permit Statement explicitly names `githubAppClientId`; every referenced app and issuer must exist in the composition. Changing app identities, audience acceptance, provider trust, or authorization requires rebuilding the reviewed artifact. Private keys remain separate runtime Worker secrets or Secrets Store bindings named by the catalogue. Do not put PEM values in the catalogue or combine keys into a JSON secret. Bindings cannot remap an app client ID. Construction validates metadata without secret or network I/O, and only the selected key is resolved for authorized issuance.

The runtime-neutral `createGitHubAppTokenExchange` configuration is `{ composition, githubApps }`; its app records contain `privateKey` instead of `privateKeyBinding`. `privateKey` accepts the existing string or structural async `get()` binding. The GitHub API origin is fixed and cannot be supplied by either factory.

Configure a trusted RPC consumer with a named service binding whose `entrypoint` is `GitHubAppInformationEntrypoint` and whose `props` is exactly `{ githubAppClientId: "Iv1.exampleApp" }`. One consumer can configure several bindings to the same service and entrypoint with different client IDs. Missing or invalid selectors fail closed; none of the four methods accepts a per-call selector.

Hostnames and convenience URLs remain deployment-owned. The broker implements no `/token` alias or body selector. A separate proxy may forward a convenience URL to an explicit canonical app route, preserving the signed subject token, request body, and response. That proxy is trusted with both credentials in transit and must preserve the broker's admission identity, reject redirects, and avoid automatic issuance retries or caching. Accepted audiences remain an explicit app capability regardless of which URL forwards the request.

Shared audiences do not imply shared authorization. A common broker audience lets an identity token be presented to several app endpoints; the selected app's Permit Statements still decide issuance. A vanity audience can be listed only for its intended app. Separate deployments remain appropriate when operators, key custody, or infrastructure trust differ.

The optional runtime `observe` adapter acknowledges mandatory high-level Token Exchange
observations by returning `Promise<void>`. The broker does not return a token until the pre-mint
intent and post-mint success observations are acknowledged. The default console adapter's
fulfilled promise establishes only that its console call completed; it is not durable storage. A
deployment that requires durable audit acknowledgement must inject an adapter whose promise
fulfills only after its chosen sink confirms persistence. Sink choice, idempotency, retry, and
timeout semantics are deployment concerns and are not supplied by this repository. Optional OIDC
remote-document diagnostics use the separate synchronous `observeOidcDiagnostic` callback and
must not be wired to the mandatory async adapter.

## Node 24 and Fastify 5 host adapter

`@github-app-token-broker/fastify` mounts a prebuilt `GitHubAppTokenExchangeHandler` into a Fastify 5
application. Its only plugin-specific option is `tokenExchange`; use Fastify's standard `prefix`
registration option when mounting the canonical app paths below an application prefix.

```ts
import { githubAppTokenExchangePlugin } from "@github-app-token-broker/fastify";
import { createGitHubAppTokenExchange } from "@github-app-token-broker/token-exchange";
import Fastify from "fastify";

const tokenExchange = createGitHubAppTokenExchange(deploymentOwnedConfiguration);
const app = Fastify(deploymentOwnedFastifyOptions);

app.addHook("onRequest", deploymentOwnedAdmissionHook);
await app.register(githubAppTokenExchangePlugin, {
  prefix: "/automation",
  tokenExchange,
});
await app.listen(deploymentOwnedListenOptions);
```

The host owns handler construction and credentials, Subject-Token Audience, admission and rate
limiting, request identity, logger construction and transport, `trustProxy`, listener options,
startup, shutdown, and signal handling. The plugin removes inherited content parsers only inside
its encapsulated scope, buffers form bodies up to the deep module's public limit, and maps only
Fastify's media-type, content-length, and body-limit parser errors to the stable OAuth response.
It also normalizes routed non-`POST` methods and malformed Fastify-to-Fetch request metadata to
that response before invoking the handler. Node may reject `TRACK` and `CONNECT` before Fastify
plugin routing, so those transport failures have no adapter OAuth-shape promise. Unrecognized
handler and Fastify errors propagate to the host. Sibling routes and parsers remain unchanged.

Mandatory observations are awaited through the request logger. A synchronous request-logger
failure rejects the mandatory callback so the deep handler fails closed; logger invocation does
not itself claim durable persistence. Optional OIDC diagnostic logging remains best effort.

`test/deployment/fastify-host` is a deny-all production-consumer fixture, not a production
composition. `pnpm run node-deploy:check` builds and production-deploys that fixture into a
temporary directory, verifies package-root ESM and declarations without source aliases, starts it
only on an ephemeral loopback socket, and then removes it.
The check consumes the current worktree and its build outputs. It does not create
a tracked-file source snapshot or enforce a clean checkout; release callers own
that boundary through the [release checklist](release.md#source-tree).

`test/deployment/integration-fastify` is the separate synthetic deployment for the
[container integration suite](../test/integration/README.md). It bundles the
composition and broker code, then runs from a production-pruned directory. Its
signed issuance and upstream-failure checks complement the package-root consumer
contract above.

## External Cloudflare Worker deployment contract

The deployment system is maintained outside this repository. It must:

1. select and pin a reviewed source revision
2. install with Node 24 and the source repository's pinned Corepack/pnpm version
3. run the public source checks independently
4. compile a deployment-owned TypeScript entrypoint with its app catalogue, OIDC Provider Registrations, and app-qualified Token Issuance Policy; construct the named RPC export from the same catalogue
5. test the exact composition, including accepted and rejected requests, without deriving expectations from the policy under test
6. preserve the source compatibility date and flags unless a reviewed deployment change intentionally updates them
7. supply the deployment-owned Worker name, canonical routes, named private-key bindings, rate-limit namespace, and Cloudflare credentials
8. run a strict dry-run against the deployment-owned entrypoint
9. smoke-test the routed `POST /github/apps/{app_slug}/token` contract without logging tokens
10. exercise `GitHubAppInformationEntrypoint` through an explicitly configured trusted named service binding; each concrete consumer must test its exact production binding configuration and static `props.githubAppClientId` and the absence of any public HTTP route to that entrypoint
11. when durable observation is required, inject and test an acknowledgement adapter whose promise resolves only after the selected sink confirms persistence

The deployment system owns the accepted audience list for each app and its public routes. It must verify that Clients request an explicitly accepted scalar audience and independently send requests to the intended app endpoint. Audience identity is never inferred from `Host` or proxy headers.

Source maintenance workflows pin an immutable external action release and use its caller-side broker request defaults where appropriate; workflows targeting a different Repository Resource or Requested Permissions explicitly override them. The workflow files are authoritative for that caller-side contract. Direct Clients must supply a non-empty scope because the broker has no permission default.

## Public source boundary

Source CI runs independent validation workflows in parallel. Dedicated `artifact:check` and
`node-deploy:check` lanes independently validate the source-owned built Token Exchange artifact
and production-pruned Fastify consumer contracts, while the Worker dry-run lane validates the
public-safe template. Separate container integration jobs run Fastify from a
bundled, production-pruned deployment and Worker from its emitted Wrangler dry-run
bundle with `--no-bundle`. Both artifacts compile a synthetic composition and
receive disposable credentials at runtime. Native outbound Fetch reaches separate
HTTPS OIDC and GitHub mocks at the fixed production origins through network aliases. Successful source CI does not validate
a deployment-owned composition,
credentials, routes, or post-deployment smoke tests; the external deployment system retains those
responsibilities.

Never commit Cloudflare account IDs or tokens, production GitHub App identities or private keys, `.dev.vars`, `.env`, `.wrangler/`, `.local-secrets/`, private deployment overlays, or production route details. Build from tracked files or an explicit archive, not an ambient working directory.
