import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const selected = process.argv[2];
assert.ok(
  process.argv.length <= 3 &&
    (selected === undefined || selected === "fastify" || selected === "worker"),
  "Usage: node scripts/test-integration.mjs [fastify|worker]",
);
let active;
let interrupted = false;
let cleaning = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    interrupted = true;
    if (!cleaning) active?.kill(signal);
  });

async function runHost(host) {
  const args = [
    "compose",
    "--project-name",
    `broker-integration-${process.pid}-${host}`,
    "--file",
    "test/integration/compose.yml",
  ];
  const run = (...command) =>
    new Promise((resolve, reject) => {
      active = spawn("docker", [...args, ...command], {
        stdio: "inherit",
        env: { ...process.env, INTEGRATION_HOST: host },
      });
      active.once("error", reject);
      active.once("exit", (code) => {
        active = undefined;
        resolve(code ?? 1);
      });
    });
  let status = 1;
  cleaning = false;
  try {
    const started = await run("up", "--build", "--detach");
    if (started === 0 && !interrupted) {
      status = await run("wait", "tests");
      await run("logs", "--no-color", "tests");
    }
    if (status !== 0)
      await run("logs", "--no-color", "--tail", "100", "prepare", "broker", "oidc", "github");
  } finally {
    cleaning = true;
    const cleanup = await run("down", "--volumes", "--remove-orphans", "--rmi", "all");
    if (cleanup !== 0 || interrupted) status = 1;
  }
  return status;
}

let status = 0;
for (const host of selected === undefined ? ["fastify", "worker"] : [selected]) {
  if (interrupted) break;
  if ((await runHost(host)) !== 0) status = 1;
}
process.exitCode = interrupted ? 1 : status;
