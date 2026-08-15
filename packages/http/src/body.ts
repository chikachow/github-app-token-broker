export type BoundedBodyRead =
  | {
      bytes: Uint8Array;
      ok: true;
    }
  | {
      ok: false;
    };

export async function readBodyUpTo(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<BoundedBodyRead> {
  throwIfAborted(signal);

  if (body === null) {
    return { bytes: new Uint8Array(), ok: true };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const cancelForAbort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };

  signal?.addEventListener("abort", cancelForAbort, { once: true });

  try {
    throwIfAborted(signal);

    for (;;) {
      const read = await reader.read();
      throwIfAborted(signal);

      if (read.done) {
        break;
      }

      totalBytes += read.value.byteLength;

      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return { ok: false };
      }

      chunks.push(read.value);
    }
  } finally {
    signal?.removeEventListener("abort", cancelForAbort);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes, ok: true };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
}
