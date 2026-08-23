import { describe, expect, it, vi } from "vitest";

import { readBodyUpTo } from "@github-app-token-broker/http/body";

describe("bounded body reading", () => {
  it("accepts an absent body as empty", async () => {
    await expect(readBodyUpTo(null, 0)).resolves.toEqual({
      bytes: new Uint8Array(),
      ok: true,
    });
  });

  it("accepts a body at the exact byte limit", async () => {
    await expect(readBodyUpTo(new Response("abc").body, 3)).resolves.toEqual({
      bytes: new TextEncoder().encode("abc"),
      ok: true,
    });
  });

  it("reassembles subarray-backed chunks without advancing for empty chunks", async () => {
    const firstBacking = Uint8Array.of(9, 1, 2, 9);
    const secondBacking = Uint8Array.of(9, 3, 9);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array());
        controller.enqueue(firstBacking.subarray(1, 3));
        controller.enqueue(new Uint8Array());
        controller.enqueue(secondBacking.subarray(1, 2));
        controller.close();
      },
    });

    await expect(readBodyUpTo(body, 3)).resolves.toEqual({
      bytes: Uint8Array.of(1, 2, 3),
      ok: true,
    });
  });

  it("stops reading and requests cancellation after the byte limit", async () => {
    const cancel = vi.fn();
    let pullCount = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        cancel,
        pull(controller) {
          pullCount += 1;
          controller.enqueue(new Uint8Array(2));
        },
      },
      { highWaterMark: 0 },
    );

    await expect(readBodyUpTo(body, 3)).resolves.toEqual({ ok: false });
    expect(pullCount).toBe(2);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not wait for transport cancellation before rejecting an oversized body", async () => {
    const body = new ReadableStream<Uint8Array>(
      {
        cancel: () => new Promise<void>(() => undefined),
        pull(controller) {
          controller.enqueue(new Uint8Array(2));
        },
      },
      { highWaterMark: 0 },
    );

    await expect(readBodyUpTo(body, 1)).resolves.toEqual({ ok: false });
  });

  it("ignores a rejected best-effort transport cancellation", async () => {
    const body = new ReadableStream<Uint8Array>(
      {
        cancel: () => Promise.reject(new Error("transport cancellation failed")),
        pull(controller) {
          controller.enqueue(new Uint8Array(2));
        },
      },
      { highWaterMark: 0 },
    );

    await expect(readBodyUpTo(body, 1)).resolves.toEqual({ ok: false });
    await Promise.resolve();
  });

  it("cancels an in-progress body read and rejects with the abort reason", async () => {
    const cancel = vi.fn();
    const controller = new AbortController();
    const abortReason = new DOMException("fixture deadline", "TimeoutError");
    const body = new ReadableStream<Uint8Array>({ cancel });
    const read = readBodyUpTo(body, 3, controller.signal);

    controller.abort(abortReason);

    await expect(read).rejects.toBe(abortReason);
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith(abortReason);
  });

  it("does not start reading a body when its signal is already aborted", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const controller = new AbortController();
    const abortReason = new DOMException("fixture cancellation", "AbortError");

    controller.abort(abortReason);

    await expect(
      readBodyUpTo(
        new ReadableStream<Uint8Array>({ cancel, pull }, { highWaterMark: 0 }),
        3,
        controller.signal,
      ),
    ).rejects.toBe(abortReason);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
});
