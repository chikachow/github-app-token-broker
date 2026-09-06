import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { unstable_readConfig as readConfig } from "wrangler";

const source = readConfig({ config: "workers/github-app-token-broker/wrangler.jsonc" });
// Inherit the actual runtime flags and local rate-limit binding from the source template.
await writeFile(
  "test/integration/.generated/wrangler.json",
  JSON.stringify({
    name: "integration-broker",
    main:
      process.env.INTEGRATION_FAIL_OBSERVATION === "true"
        ? "../worker-observation-failure.ts"
        : "../worker.ts",
    compatibility_date: source.compatibility_date,
    compatibility_flags: source.compatibility_flags,
    ratelimits: source.ratelimits,
    vars: {
      GITHUB_APP_ID: "123456",
      GITHUB_APP_PRIVATE_KEY: await readFile("test/integration/.generated/app.pem", "utf8"),
      TOKEN_BROKER_AUDIENCE: "urn:integration:broker",
    },
  }),
);
const child = spawn(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "dev",
    "--config",
    "test/integration/.generated/wrangler.json",
    "--local",
    "--ip",
    "0.0.0.0",
    "--port",
    "8080",
    "--inspector-port",
    "0",
    "--log-level",
    "warn",
  ],
  { stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
child.once("exit", (code) => process.exit(code ?? 1));
