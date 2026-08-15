import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GitHub App Information RPC", () => {
  it("returns GitHub App information through the named Worker entrypoint", async () => {
    await expect(exports.GitHubAppInformationEntrypoint.getApp()).resolves.toMatchObject({
      id: 2419473,
      owner: { login: "fixture-owner" },
    });
  });

  it("preserves a sanitized input error across Worker RPC", async () => {
    await expectRpcError(
      exports.GitHubAppInformationEntrypoint.getInstallation({ installation_id: 0 }),
      {
        message: "invalid GitHub App information request",
        name: "GitHubAppInputError",
      },
    );
  });

  it("preserves a sanitized upstream error across Worker RPC", async () => {
    await expectRpcError(
      exports.GitHubAppInformationEntrypoint.getInstallation({ installation_id: 99999 }),
      {
        message: "GitHub App information request failed upstream",
        name: "GitHubAppUpstreamError",
      },
    );
  });

  it("preserves a sanitized configuration error for rejected App credentials across Worker RPC", async () => {
    await expectRpcError(
      exports.GitHubAppInformationEntrypoint.getInstallation({ installation_id: 40101 }),
      {
        message: "invalid GitHub App configuration",
        name: "GitHubAppConfigurationError",
      },
    );
  });
});

async function expectRpcError(
  operation: Promise<unknown>,
  expected: { readonly message: string; readonly name: string },
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toMatchObject(expected);
    return;
  }

  throw new Error(`expected ${expected.name}`);
}
