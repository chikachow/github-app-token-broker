import { createTokenExchangeWorker } from "@github-app-token-broker/worker";
import { composition } from "./composition.ts";

/** @public */
export { GitHubAppInformationEntrypoint } from "@github-app-token-broker/worker";
/** @public */
export default createTokenExchangeWorker(composition, {
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
  observe: async (observation) => {
    console.log(
      JSON.stringify({
        ...observation.fields,
        level: observation.level,
        message: observation.message,
      }),
    );
  },
});
