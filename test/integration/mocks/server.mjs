import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";

export const readFixture = (name) => readFileSync(`test/integration/.generated/${name}`, "utf8");

export function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-cache",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

export async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    assert.ok(size <= 65536, "fixture body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

export function stallResponse(response, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.write('{"incomplete":');
  const timeout = setTimeout(() => response.end(), 20000);
  response.once("close", () => clearTimeout(timeout));
}

export function createMockServer(name) {
  let events = [];
  let failures = [];
  const record = (event) => {
    assert.ok(events.length < 200, "fixture request budget exceeded");
    events.push(event);
  };
  const guarded = (handler) => (request, response) => {
    void handler(request, response).catch(() => {
      // Never record assertions containing authorization headers or signed tokens.
      failures.push({ method: request.method, path: request.url });
      if (response.headersSent) response.destroy();
      else sendJson(response, 500, { error: "fixture_contract_violation" });
    });
  };
  return {
    record,
    recordResponseClose(response) {
      const requestEvents = events;
      response.once("close", () => requestEvents.push({ kind: "response-closed" }));
    },
    reset() {
      events = [];
      failures = [];
    },
    async listen(protocol, controls) {
      const tls = httpsServer(
        { key: readFixture(`${name}.tls.key`), cert: readFixture(`${name}.crt`) },
        guarded(async (request, response) => {
          record({ method: request.method, path: request.url });
          await protocol(request, response);
        }),
      );
      const control = httpServer(
        guarded(async (request, response) => {
          if (request.method === "GET" && request.url === "/health")
            return sendJson(response, 200, { ready: true });
          if (request.method === "GET" && request.url === "/state")
            return sendJson(response, 200, { events, failures });
          await controls(request, response);
        }),
      );
      await Promise.all([
        new Promise((resolve) => tls.listen(443, "0.0.0.0", resolve)),
        new Promise((resolve) => control.listen(8081, "0.0.0.0", resolve)),
      ]);
      console.log(`${name} fixture ready`);
      for (const signal of ["SIGINT", "SIGTERM"])
        process.once(signal, () => {
          tls.closeAllConnections();
          control.closeAllConnections();
          tls.close();
          control.close();
        });
    },
  };
}
