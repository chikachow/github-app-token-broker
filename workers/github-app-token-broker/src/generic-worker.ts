import { compileTokenIssuancePolicy } from "@github-app-token-broker/token-issuance-policy";

import { createTokenExchangeWorker } from "./worker.ts";

import { createGitHubAppInformationEntrypoint } from "./app-information-entrypoint.ts";

export const GitHubAppInformationEntrypoint = createGitHubAppInformationEntrypoint([]);

export default createTokenExchangeWorker({
  githubApps: [],
  oidcProviderRegistrations: [],
  tokenIssuancePolicy: compileTokenIssuancePolicy([]),
});
