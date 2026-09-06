import { createTokenExchangeWorker } from "@github-app-token-broker/worker";
import { composition } from "./composition.ts";

/** @public */
export default createTokenExchangeWorker(composition, {
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
  observe: async (observation) => {
    if (observation.fields["event"] === "installation_access_token_issuance_succeeded") {
      throw new Error("synthetic observation failure");
    }
  },
});
