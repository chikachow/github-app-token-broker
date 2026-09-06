import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// These tests run in the isolated Compose driver or an Actions runner. The broker
// services use other containers, leaving the supervisor's loopback ports free.
const supervisor = fileURLToPath(new URL("./host.mjs", import.meta.url));
const listener = `
import { createServer } from "node:http";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
appendFileSync("starts", process.pid + "\\n");
const generation = readFileSync("starts", "utf8").trim().split("\\n").length;
const server = createServer((request, response) => {
  response.writeHead(process.env.TEST_PHASE === "starting" && generation === 2 ? 503 : 400).end();
});
server.listen(8080, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    writeFileSync("stopping-" + generation, "");
    const timer = setInterval(() => {
      if (process.env.TEST_PHASE !== "stopping" || generation !== 1 || existsSync("release")) {
        clearInterval(timer);
        server.close();
      }
    }, 5);
  });
`;
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, "lifecycle condition did not occur");
    await delay(10);
  }
}
const controlOpen = () =>
  new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: 8081 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
for (const [phase, signal] of [
  ["stopping", "SIGINT"],
  ["stopping", "SIGTERM"],
  ["starting", "SIGTERM"],
])
  void it(`makes ${signal} terminal while reset is ${phase}`, { timeout: 15000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), "broker-host-lifecycle-"));
    const path = (name) => join(directory, name);
    mkdirSync(path("test/integration"), { recursive: true });
    writeFileSync(path("test/integration/fastify.mjs"), listener);
    const generations = () =>
      existsSync(path("starts")) ? readFileSync(path("starts"), "utf8").trim().split("\n") : [];
    const child = spawn(process.execPath, [supervisor], {
      cwd: directory,
      env: { ...process.env, INTEGRATION_HOST: "fastify", TEST_PHASE: phase },
      stdio: "inherit",
    });
    try {
      await waitFor(controlOpen);
      const reset = fetch("http://127.0.0.1:8081/reset", {
        method: "POST",
        headers: { connection: "close" },
        signal: AbortSignal.timeout(10000),
      });
      // Keep a cleanup path even when the supervisor fails before responding.
      void reset.catch(() => {});
      await waitFor(() =>
        phase === "stopping" ? existsSync(path("stopping-1")) : generations().length === 2,
      );
      child.kill(signal);
      await waitFor(async () => !(await controlOpen()));
      // A second signal must not initiate another concurrent lifecycle operation.
      child.kill(signal);
      child.kill(signal === "SIGINT" ? "SIGTERM" : "SIGINT");
      writeFileSync(path("release"), "");
      assert.equal((await reset).status, 503, "shutdown must cancel the reset");
      if (child.exitCode === null) await once(child, "exit", { signal: AbortSignal.timeout(5000) });
      assert.equal(child.exitCode, 0);
      assert.equal(generations().length, phase === "stopping" ? 1 : 2);
      for (const pid of generations())
        assert.throws(() => process.kill(-Number(pid), 0), { code: "ESRCH" });
    } finally {
      for (const pid of generations()) {
        try {
          process.kill(-Number(pid), "SIGKILL");
        } catch (error) {
          assert.equal(error.code, "ESRCH");
        }
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
