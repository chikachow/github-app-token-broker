import assert from "node:assert/strict";

import * as tokenExchange from "../dist/index.js";

assert.deepEqual(Object.keys(tokenExchange).sort(), [
  "compileGitHubAppTokenExchange",
  "createGitHubAppTokenExchange",
  "maxTokenExchangeBodyBytes",
  "snapshotGitHubAppMetadata",
  "tokenExchangeInvalidRequestResponse",
  "unexpectedTokenExchangeFailureResponse",
]);
assert.equal(tokenExchange.maxTokenExchangeBodyBytes, 64 * 1024);

const response = tokenExchange.tokenExchangeInvalidRequestResponse(413);

assert.equal(response.status, 413);
assert.equal(response.headers.get("cache-control"), "no-store");
assert.deepEqual(await response.json(), { error: "invalid_request" });

const originalConsoleError = console.error;
let failureResponse;
try {
  console.error = () => {
    throw new Error("unavailable logger");
  };
  failureResponse = tokenExchange.unexpectedTokenExchangeFailureResponse({
    privateDetail: "must not be returned",
  });
} finally {
  console.error = originalConsoleError;
}
assert.equal(failureResponse.status, 500);
assert.equal(failureResponse.headers.get("cache-control"), "no-store");
assert.equal(failureResponse.headers.get("pragma"), "no-cache");
assert.deepEqual(await failureResponse.json(), { error: "server_error" });

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

const compiled = tokenExchange.compileGitHubAppTokenExchange({
  composition: { oidcProviderRegistrations: [], tokenIssuancePolicy: { permitStatements: [] } },
  githubApps: [
    { slug: "example", clientId: "Iv1.example", subjectTokenAudiences: ["urn:example"] },
  ],
});
assert(Object.isFrozen(compiled));
assert(Object.isFrozen(compiled.tokenEndpointPaths));
const bound = compiled.bindPrivateKeys([{ clientId: "Iv1.example", privateKey: "unused" }]);
assert.strictEqual(bound.tokenEndpointPaths, compiled.tokenEndpointPaths);
assert.equal(
  (
    await bound(new Request("https://example.test/github/apps/example/token"), {
      observe: async () => {},
    })
  ).status,
  400,
);

const selected = compiled.bindPrivateKey("/github/apps/example/token", {
  clientId: "Iv1.example",
  privateKey: "unused",
});
assert(Object.isFrozen(selected));
assert.equal(
  (
    await selected(new Request("https://example.test/github/apps/example/token"), {
      observe: async () => {},
    })
  ).status,
  400,
);
assert.equal(
  (
    await selected(new Request("https://example.test/github/apps/other/token"), {
      observe: async () => {},
    })
  ).status,
  404,
);
assert.throws(
  () =>
    compiled.bindPrivateKey("/github/apps/example/token", {
      clientId: "Iv1.other",
      privateKey: "unused",
    }),
  TypeError,
);
