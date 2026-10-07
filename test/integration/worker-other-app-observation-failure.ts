import {
  createTokenExchangeWorker,
  createGitHubAppInformationEntrypoint,
} from "@github-app-token-broker/worker";
import { composition } from "./composition.ts";

/** @public */
export const GitHubAppInformationEntrypoint = createGitHubAppInformationEntrypoint(
  composition.githubApps,
);
/** @public */
export default createTokenExchangeWorker(composition, {
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
  observe: async (observation) => {
    const app = observation.fields["github_app"];
    if (
      observation.fields["event"] === "installation_access_token_issuance_succeeded" &&
      typeof app === "object" &&
      app !== null &&
      "client_id" in app &&
      app.client_id === "Iv1.otherApp"
    ) {
      throw new Error("synthetic App B observation failure");
    }
  },
});
