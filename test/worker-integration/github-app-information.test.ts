import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GitHub App Information RPC", () => {
  it("passes installation input and output through the named Worker entrypoint", async () => {
    await expect(
      exports.GitHubAppInformationEntrypoint.getInstallation({ installation_id: 12345 }),
    ).resolves.toMatchObject({
      account: { login: "fixture-owner" },
      app_id: 2419473,
      id: 12345,
      repository_selection: "all",
    });
  });
});
