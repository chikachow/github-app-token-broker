import { createGitHubAppInformationEntrypoint } from "@github-app-token-broker/worker";

export const GitHubAppInformationEntrypoint = createGitHubAppInformationEntrypoint([
  {
    clientId: "Iv1.fixtureApp",
    slug: "fixture-app",
    privateKeyBinding: "APP_A_KEY",
    subjectTokenAudiences: ["https://broker.example"],
  },
  {
    clientId: "Iv1.otherApp",
    slug: "other-app",
    privateKeyBinding: "APP_B_KEY",
    subjectTokenAudiences: ["https://broker.example"],
  },
]);

export default { fetch: () => new Response(null, { status: 404 }) } satisfies ExportedHandler;
