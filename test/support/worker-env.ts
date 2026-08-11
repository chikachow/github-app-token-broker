import { env } from "cloudflare:workers";

import { testPrivateKeyPem } from "./rsa-test-key-pair.ts";

type TestEnv = TokenExchangeEnv;

const workerEnv = env as unknown as TestEnv;

const testTokenExchangeRateLimit = {
  limit: async () => ({ success: true }),
} satisfies RateLimit;

export const testEnv: TestEnv = {
  ...workerEnv,
  GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem,
  TOKEN_BROKER_AUDIENCE: "https://broker.example",
  TOKEN_EXCHANGE_RATE_LIMIT: testTokenExchangeRateLimit,
};
