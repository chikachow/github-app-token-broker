import type { GitHubAppInformation } from "@github-app-token-broker/github/app-information";
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

export default {
  async fetch(request, env) {
    const binding = env[new URL(request.url).pathname.slice(1)];
    if (binding === undefined) return new Response(null, { status: 404 });
    try {
      return Response.json(await binding.getInstallation({ installation_id: 12345 }));
    } catch (error) {
      return Response.json(
        { name: error instanceof Error ? error.name : "Error" },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<Record<string, GitHubAppInformation>>;
