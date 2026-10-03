import type { GitHubAppInformation } from "@github-app-token-broker/github/app-information";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const bindings = env as unknown as Record<"APP_A" | "APP_B", GitHubAppInformation>;

describe("GitHub App Information RPC", () => {
  it("passes installation input and output through the named Worker entrypoint", async () => {
    await expect(bindings.APP_A.getInstallation({ installation_id: 12345 })).resolves.toMatchObject(
      {
        account: { login: "fixture-owner" },
        app_id: 2419473,
        id: 12345,
        repository_selection: "all",
      },
    );
  });
  it("lets one consumer bind separately to two apps", async () => {
    const [first, second] = await Promise.all([
      bindings.APP_A.getInstallation({ installation_id: 12345 }),
      bindings.APP_B.getInstallation({ installation_id: 12345 }),
    ]);
    expect(first.app_id).toBe(2419473);
    expect(second.app_id).toBe(7654321);
  });
});
