# Buildkite composition recipe

[composition.ts](composition.ts) is a synthetic composition recipe using the
public provider and policy interfaces. Its identifiers are illustrative, not
deployment inventory. Copy and review it in the external deployment that builds
your broker. This directory supplies a composition and a request snippet; the
external deployment owns the runnable application. The public generic Worker
remains deny-all.

The [focused example tests](../../test/buildkite-composition-example.test.ts)
exercise the recipe's authorization behavior. The container integration suite
uses its own synthetic composition to test provider and host integration.

The example authorizes any verified job satisfying its organization UUID, pipeline
UUID, branch, and step predicates. It assumes a trusted pipeline whose editing,
build creation, fork handling, and agent execution are controlled. Matching `main`
and `publish` does not prove trusted code provenance. The statement does not exclude
tag builds or any trigger source; those claims are unselected. See the
[research](../../docs/research/buildkite-oidc.md#provenance-limitation).

## Use the composition in a deployment

After reviewing the recipe's issuer, Claim predicates, target repository, and
permissions, a deployment-owned Worker entrypoint can import its local copy:

```ts
import { createTokenExchangeWorker } from "@github-app-token-broker/worker";
import { buildkiteExampleComposition } from "./composition.ts";

export { GitHubAppInformationEntrypoint } from "@github-app-token-broker/worker";
export default createTokenExchangeWorker(buildkiteExampleComposition);
```

Follow the [Worker deployment contract](../../docs/deployment.md#external-cloudflare-worker-deployment-contract)
for the pinned source revision, build, audience, credentials, bindings, and routes.
For a Node host, supply the composition to `createGitHubAppTokenExchange` and use
the [Fastify adapter](../../docs/deployment.md#node-24-and-fastify-5-host-adapter).
Deployment-owned identifiers and credentials stay outside this example.

## Request-only shell snippet

Run inside a Buildkite job whose claims match your reviewed composition. The
`organization_id` and `pipeline_id` claims must be explicitly requested. Use your
deployment's exact audience and trusted canonical HTTPS Token Exchange Endpoint;
the audience is configured separately from the endpoint URL.

This snippet demonstrates ID Token acquisition and the HTTP exchange. It checks
the HTTP status and stores the response in a private temporary directory, which
is removed on exit. It does not validate or consume the returned Installation
Access Token. Add the response handling described below before using a token in
a job; running the snippet alone performs no GitHub operation.

It uses `curl` and does not print either token. Keep shell tracing disabled and Buildkite's token
redaction enabled, including its required agent job access in containerized jobs.
Do not use `--skip-redaction`.

```sh
set -eu
set +x
: "${BROKER_AUDIENCE:?Set the deployment-owned audience}"
: "${BROKER_TOKEN_URL:?Set the trusted HTTPS token endpoint}"
umask 077
exchange_dir=$(mktemp -d)
trap 'rm -rf "$exchange_dir"' EXIT

subject_token=$(buildkite-agent oidc request-token \
  --audience "$BROKER_AUDIENCE" \
  --claim organization_id,pipeline_id \
  --lifetime 300)
printf '%s' "$subject_token" > "$exchange_dir/subject.jwt"
unset subject_token

status=$(curl --disable --silent --show-error --proto '=https' --max-time 20 \
  --output "$exchange_dir/response.json" --write-out '%{http_code}' \
  --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange' \
  --data-urlencode 'subject_token_type=urn:ietf:params:oauth:token-type:id_token' \
  --data-urlencode 'requested_token_type=urn:ietf:params:oauth:token-type:access_token' \
  --data-urlencode "subject_token@$exchange_dir/subject.jwt" \
  --data-urlencode 'resource=https://api.github.com/repos/example-owner/target' \
  --data-urlencode 'scope=contents:write' \
  "$BROKER_TOKEN_URL")
test "$status" = 200
```

`curl --disable` ignores user curl configuration, redirects are not followed, and
only HTTP 200 proceeds. A job using the returned credential must parse and validate
the response within the same script before temporary-directory cleanup: check the
returned token type and exact scope, and pass the access token to the intended
GitHub operation without printing it. The broker returns the explicitly requested
permissions, not its policy maximum. Register the issued credential with your
job's redaction mechanism before running tools that might log it.

Missing or incorrectly typed selected claims do not match the example's positive
predicates. They can authenticate successfully but cannot authorize this request.
Slug renames and subject customization do not change its UUID/context constraints.
Existing observations record issuer, subject, and verification information; they
do not identify individual failed predicates.

A real Buildkite job against a deployment-owned composition is a separate rollout
smoke test. The example's automated tests use synthetic signed tokens and do not
execute the Buildkite agent or this shell snippet.
