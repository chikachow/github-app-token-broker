import { createTokenExchangeWorker } from "@github-app-token-broker/worker";
import { composition } from "./composition.ts";

/** @public */
export { GitHubAppInformationEntrypoint } from "@github-app-token-broker/worker";
/** @public */
export default createTokenExchangeWorker(composition);
