import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createTokenExchangeRequestBody } from "../support/oidc-token.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      OIDC_TEST_PRIVATE_KEY: string;
    }
  }
}

describe("token exchange Worker OIDC registration", () => {
  it("does not trust an unregistered Fly issuer", async () => {
    const response = await exports.default.fetch("https://example.test/token", {
      body: await createTokenExchangeRequestBody(env.OIDC_TEST_PRIVATE_KEY, {
        claims: {
          app_name: "fixture-app",
          machine_name: "fixture-machine",
          org_name: "integration-direct",
          sub: "integration-direct:fixture-app:fixture-machine",
        },
        tokenOptions: {
          issuer: "https://oidc.fly.io/integration-direct",
        },
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
  });
});
