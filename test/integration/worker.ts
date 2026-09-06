import { createTokenExchangeWorker } from "@github-app-token-broker/worker";
import { composition } from "./composition.ts";

/** @public */
export default createTokenExchangeWorker(composition);
