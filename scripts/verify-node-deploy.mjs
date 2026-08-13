import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const deployDirectory = mkdtempSync(join(tmpdir(), "github-app-token-broker-deploy-"));
try {
  execFileSync(
    "pnpm",
    ["--filter", "@github-app-token-broker/example-fastify-host", "run", "build"],
    { stdio: "inherit" },
  );
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

  const entrypoint = join(deployDirectory, "dist/index.mjs");
  const emittedJavaScript = readFileSync(entrypoint, "utf8");
  if (emittedJavaScript.includes("@github-app-token-broker/")) {
    throw new Error("deployed Node entrypoint retained a runtime workspace-package import");
  }

  const { createExampleFastifyHost } = await import(pathToFileURL(entrypoint).href);
  const app = await createExampleFastifyHost();
  try {
    const response = await app.inject({ method: "GET", url: "/token" });
    if (response.statusCode !== 400 || response.json().error !== "invalid_request") {
      throw new Error("deployed Fastify host did not preserve the token endpoint contract");
    }
  } finally {
    await app.close();
  }

  const JavaScriptConsumerPath = join(deployDirectory, "package-consumer.mjs");
  writeFileSync(
    JavaScriptConsumerPath,
    `import { githubAppTokenExchangePlugin } from "@github-app-token-broker/fastify";
import { createGitHubAppTokenExchange } from "@github-app-token-broker/token-exchange";

const tokenExchange = createGitHubAppTokenExchange({
  composition: {
    oidcProviderRegistrations: [],
    tokenIssuancePolicy: { permitStatements: [] },
  },
  githubApp: {
    appId: "package-consumer",
    privateKey: "not-a-real-private-key",
  },
  subjectTokenAudience: "https://broker.example",
});

if (typeof tokenExchange !== "function" || typeof githubAppTokenExchangePlugin !== "function") {
  throw new Error("deployed package roots did not expose their runtime interfaces");
}
`,
  );
  execFileSync(process.execPath, [JavaScriptConsumerPath], {
    cwd: deployDirectory,
    stdio: "inherit",
  });

  const TypeScriptConsumerPath = join(deployDirectory, "package-consumer.ts");
  writeFileSync(
    TypeScriptConsumerPath,
    `import {
  githubAppTokenExchangePlugin,
  type GitHubAppTokenExchangePluginOptions,
} from "@github-app-token-broker/fastify";
import {
  createGitHubAppTokenExchange,
  type GitHubAppTokenExchangeConfiguration,
  type TokenExchangeHandler,
  type TokenExchangeRequestContext,
} from "@github-app-token-broker/token-exchange";

const configuration = {
  composition: {
    oidcProviderRegistrations: [],
    tokenIssuancePolicy: { permitStatements: [] },
  },
  githubApp: {
    appId: "package-consumer",
    privateKey: "not-a-real-private-key",
  },
  subjectTokenAudience: "https://broker.example",
} satisfies GitHubAppTokenExchangeConfiguration;

const tokenExchange: TokenExchangeHandler = createGitHubAppTokenExchange(configuration);
const options: GitHubAppTokenExchangePluginOptions = { tokenExchange };
// @ts-expect-error Rate limiting is deliberately owned by the Fastify host.
const invalidOptions: GitHubAppTokenExchangePluginOptions = { tokenExchange, rateLimiter: {} };
const context: TokenExchangeRequestContext = { observe: () => undefined };

void githubAppTokenExchangePlugin;
void options;
void invalidOptions;
void context;
`,
  );

  const tsconfigPath = join(deployDirectory, "tsconfig.consumer.json");
  writeFileSync(
    tsconfigPath,
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: "ES2024",
          typeRoots: [join(process.cwd(), "test/deployment/fastify-host/node_modules/@types")],
          types: ["node"],
        },
        files: [TypeScriptConsumerPath],
      },
      null,
      2,
    )}\n`,
  );
  execFileSync("pnpm", ["exec", "tsc", "--project", tsconfigPath], { stdio: "inherit" });
} finally {
  rmSync(deployDirectory, { force: true, recursive: true });
}
