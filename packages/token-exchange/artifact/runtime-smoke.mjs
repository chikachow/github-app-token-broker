import assert from "node:assert/strict";

import * as tokenExchange from "../dist/index.js";

assert.deepEqual(Object.keys(tokenExchange).sort(), [
  "createGitHubAppTokenExchange",
  "maxTokenExchangeBodyBytes",
  "snapshotGitHubApps",
  "tokenExchangeInvalidRequestResponse",
]);
assert.equal(tokenExchange.maxTokenExchangeBodyBytes, 64 * 1024);

const response = tokenExchange.tokenExchangeInvalidRequestResponse(413);

assert.equal(response.status, 413);
assert.equal(response.headers.get("cache-control"), "no-store");
assert.deepEqual(await response.json(), { error: "invalid_request" });

const broker = tokenExchange.createGitHubAppTokenExchange({
  composition: { oidcProviderRegistrations: [], tokenIssuancePolicy: { permitStatements: [] } },
  githubApps: [
    {
      slug: "example",
      clientId: "Iv1.example",
      subjectTokenAudiences: ["urn:example"],
      privateKey: "unused",
    },
  ],
});
assert.deepEqual(broker.tokenEndpointPaths, ["/github/apps/example/token"]);
assert(Object.isFrozen(broker));
assert(Object.isFrozen(broker.tokenEndpointPaths));
