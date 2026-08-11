import { compileTokenIssuancePolicy } from "@github-app-token-broker/token-issuance-policy";

import { createTokenExchangeWorker } from "./worker.ts";

export default createTokenExchangeWorker({
  oidcProviderRegistrations: [],
  tokenIssuancePolicy: compileTokenIssuancePolicy([]),
});
