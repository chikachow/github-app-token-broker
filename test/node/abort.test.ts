import { spawnSync } from "node:child_process";
import process from "node:process";

import { awaitWithAbortSignal } from "@github-app-token-broker/http/abort";
import { describe, expect, it } from "vitest";

describe("awaitWithAbortSignal", () => {
  it("preserves normal operation values and rejection reasons", async () => {
    const signal = new AbortController().signal;
    const value = { fixture: true };
    const failure = new Error("operation failure");

    await expect(awaitWithAbortSignal(Promise.resolve(value), signal)).resolves.toBe(value);
    await expect(awaitWithAbortSignal(Promise.reject(failure), signal)).rejects.toBe(failure);
  });

  it.each(["before", "after"] as const)(
    "rejects without waiting when cancellation occurs %s wrapping a pending operation",
    async (when) => {
      const controller = new AbortController();
      const reason = new Error("caller cancellation");
      if (when === "before") controller.abort(reason);
      const result = awaitWithAbortSignal(new Promise<never>(() => undefined), controller.signal);
      if (when === "after") controller.abort(reason);

      await expect(result).rejects.toBe(reason);
    },
  );

  it.each(["before", "after"] as const)(
    "handles late operation rejection when cancellation occurs %s wrapping it",
    (when) => {
      const child = spawnSync(
        process.execPath,
        [
          "--unhandled-rejections=strict",
          "--input-type=module",
          "--eval",
          `import assert from "node:assert/strict";
import { awaitWithAbortSignal } from "@github-app-token-broker/http/abort";
const controller = new AbortController();
const reason = new Error("caller cancellation");
const operation = Promise.withResolvers();
if (${when === "before"}) controller.abort(reason);
const result = awaitWithAbortSignal(operation.promise, controller.signal);
if (${when === "after"}) controller.abort(reason);
await assert.rejects(result, (error) => error === reason);
operation.reject(new Error("late operation failure"));
await new Promise(setImmediate);
await assert.rejects(
  awaitWithAbortSignal(Promise.reject(new Error("immediate operation failure")), controller.signal),
  (error) => error === reason,
);
await new Promise(setImmediate);
`,
        ],
        {
          cwd: new URL("../../", import.meta.url),
          encoding: "utf8",
          timeout: 5000,
        },
      );

      expect(child.error).toBeUndefined();
      expect(child.signal).toBeNull();
      expect(child.status, child.stderr).toBe(0);
    },
  );
});
