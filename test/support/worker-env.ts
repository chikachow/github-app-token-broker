import { env } from "cloudflare:workers";

import { testPrivateKeyPem } from "./rsa-test-key-pair.ts";

type TestEnv = TokenExchangeEnv & {
  readonly GITHUB_APP_PRIVATE_KEY: import("@github-app-token-broker/github/secrets").SecretTextBinding;
};

const workerEnv = env as unknown as TestEnv;

const testTokenExchangeRateLimit = {
  limit: async () => ({ success: true }),
} satisfies RateLimit;

export const testEnv = {
  ...workerEnv,
  GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem,
  TOKEN_EXCHANGE_RATE_LIMIT: testTokenExchangeRateLimit,
} satisfies TestEnv;
