import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const deployDirectory = mkdtempSync(join(tmpdir(), "github-app-token-broker-node-deploy-"));

try {
  execFileSync(
    "pnpm",
    [
      "--filter",
      "@github-app-token-broker/example-fastify-host",
      "deploy",
      "--prod",
      deployDirectory,
    ],
    { stdio: "inherit" },
  );

  const entrypoint = join(deployDirectory, "dist/index.js");
  const emittedJavaScript = readFileSync(entrypoint, "utf8");

  if (
    /\bfrom\s+["']@github-app-token-broker\//u.test(emittedJavaScript) ||
    /\bimport\(\s*["']@github-app-token-broker\//u.test(emittedJavaScript)
  ) {
    throw new Error("deployed Node entrypoint retained a runtime workspace-package import");
  }

  const runtimeConsumerPath = join(deployDirectory, "runtime-consumer.mjs");
  writeFileSync(
    runtimeConsumerPath,
    `import * as fastifyAdapter from "@github-app-token-broker/fastify";
import { createGitHubAppTokenExchange } from "@github-app-token-broker/token-exchange";

const exports = Object.keys(fastifyAdapter).sort();
if (JSON.stringify(exports) !== JSON.stringify(["githubAppTokenExchangePlugin"])) {
  throw new Error(\`unexpected Fastify adapter runtime exports: \${JSON.stringify(exports)}\`);
}
if (typeof createGitHubAppTokenExchange !== "function") {
  throw new Error("deployed token-exchange package root did not expose its runtime interface");
}
`,
  );
  execFileSync(process.execPath, [runtimeConsumerPath], {
    cwd: deployDirectory,
    stdio: "inherit",
  });

  const { createExampleFastifyHost } = await import(pathToFileURL(entrypoint).href);
  const app = await createExampleFastifyHost();
  const address = await app.listen({ host: "127.0.0.1", port: 0 });

  try {
    const response = await fetch(`${address}/automation/token`, { method: "GET" });

    if (response.status !== 400 || (await response.json()).error !== "invalid_request") {
      throw new Error(
        "deployed Fastify host did not preserve the Token Exchange Endpoint contract",
      );
    }
    if (response.headers.get("cache-control") !== "no-store") {
      throw new Error("deployed Fastify host omitted the non-cacheable OAuth response contract");
    }
  } finally {
    await app.close();
  }

  const typeConsumerPath = join(deployDirectory, "type-consumer.ts");
  writeFileSync(
    typeConsumerPath,
    `import {
  githubAppTokenExchangePlugin,
  type GitHubAppTokenExchangePluginOptions,
} from "@github-app-token-broker/fastify";
import type { TokenExchangeHandler } from "@github-app-token-broker/token-exchange";
import Fastify from "fastify";

declare const tokenExchange: TokenExchangeHandler;
const options: GitHubAppTokenExchangePluginOptions = { tokenExchange };
const app = Fastify();
await app.register(githubAppTokenExchangePlugin, { prefix: "/automation", tokenExchange });

// @ts-expect-error The GitHub API destination is fixed inside the deep module.
const apiBaseUrl: GitHubAppTokenExchangePluginOptions = { tokenExchange, apiBaseUrl: "https://example.invalid" };
// @ts-expect-error The host constructs the handler with its credentials.
const credentials: GitHubAppTokenExchangePluginOptions = { tokenExchange, githubApp: {} };
// @ts-expect-error Admission and rate limiting belong to the host.
const rateLimiter: GitHubAppTokenExchangePluginOptions = { tokenExchange, rateLimiter: {} };
// @ts-expect-error Listener configuration belongs to the host.
const listener: GitHubAppTokenExchangePluginOptions = { tokenExchange, listen: {} };

void options;
void apiBaseUrl;
void credentials;
void rateLimiter;
void listener;
await app.close();
`,
  );

  const tsconfigPath = join(deployDirectory, "tsconfig.consumer.json");
  writeFileSync(
    tsconfigPath,
    `${JSON.stringify(
      {
        compilerOptions: {
          allowImportingTsExtensions: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          target: "ES2024",
          typeRoots: [join(process.cwd(), "node_modules/@types")],
          types: ["node"],
        },
        files: [typeConsumerPath],
      },
      null,
      2,
    )}\n`,
  );
  execFileSync("pnpm", ["exec", "tsc", "--project", tsconfigPath], { stdio: "inherit" });
} finally {
  rmSync(deployDirectory, { force: true, recursive: true });
}
