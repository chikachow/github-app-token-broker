import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const role = process.env.INTEGRATION_HOST;
assert.ok(role === "fastify" || role === "worker");
let child;
let resetting;
let shuttingDown = false;
async function stop() {
  if (!child) return;
  const pid = child.pid;
  const kill = (signal) => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      return false;
    }
  };
  // The launcher can exit before its descendants release the listener and caches.
  for (const [signal, timeout] of [
    ["SIGTERM", 5000],
    ["SIGKILL", 1000],
  ]) {
    if (!kill(signal)) return;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (!kill(0)) return;
      await delay(10);
    }
  }
  throw new Error("host process group did not exit");
}
async function start(trustCa = true) {
  assert.ok(!shuttingDown, "host shutdown requested");
  const env = { ...process.env };
  if (!trustCa) delete env.NODE_EXTRA_CA_CERTS;
  child = spawn(
    process.execPath,
    [`test/integration/${role === "worker" ? "start-worker" : "fastify"}.mjs`],
    { stdio: "inherit", detached: true, env },
  );
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    assert.ok(!shuttingDown, "host shutdown requested");
    assert.equal(child.exitCode, null, "host exited during startup");
    assert.equal(child.signalCode, null, "host was killed during startup");
    try {
      const response = await fetch("http://127.0.0.1:8080/token", {
        signal: AbortSignal.timeout(1000),
      });
      await response.arrayBuffer();
      if (response.status === 400) return;
    } catch {
      /* Wait for the actual listener, not merely process creation. */
    }
    await delay(100);
  }
  throw new Error("host readiness deadline exceeded");
}
await start();
// Separate, fixture-only control socket; the broker's public routes remain untouched.
const control = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(resetting || shuttingDown ? 503 : 200).end();
    return;
  }
  if (
    request.method !== "POST" ||
    !["/reset", "/reset/untrusted-ca"].includes(request.url) ||
    resetting ||
    shuttingDown
  ) {
    response.writeHead(409).end();
    return;
  }
  resetting = (async () => {
    try {
      await stop();
      await start(request.url !== "/reset/untrusted-ca");
      response.writeHead(shuttingDown ? 503 : 204).end();
    } catch {
      response.writeHead(shuttingDown ? 503 : 500).end();
    } finally {
      resetting = undefined;
    }
  })();
});
control.listen(8081, "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    control.close();
    // Let an active reset cancel before stopping the child it owns.
    void (async () => {
      await resetting;
      await stop();
    })();
  });
