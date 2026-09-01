import { test } from "@fast-check/vitest";
import fc from "fast-check";
import { describe, expect } from "vitest";

import { readBodyUpTo } from "@github-app-token-broker/http/body";

interface BodyReadScenario {
  readonly chunks: readonly Uint8Array[];
  readonly maxBytes: number;
}

const nonEmptyViewChunkArbitrary = fc
  .tuple(
    fc.array(fc.integer({ max: 255, min: 1 }), { maxLength: 16, minLength: 1 }),
    fc.integer({ max: 4, min: 1 }),
    fc.integer({ max: 4, min: 1 }),
  )
  .map(([bytes, prefixLength, suffixLength]) => {
    const backing = new Uint8Array(prefixLength + bytes.length + suffixLength);
    backing.set(bytes, prefixLength);

    return backing.subarray(prefixLength, prefixLength + bytes.length);
  });
const bodyReadScenarioArbitrary: fc.Arbitrary<BodyReadScenario> = fc
  .tuple(
    fc.array(nonEmptyViewChunkArbitrary, { maxLength: 8, minLength: 2 }),
    fc.integer({ max: 32, min: 0 }),
  )
  .map(([nonEmptyChunks, headroom]) => {
    const chunks = [
      ...nonEmptyChunks.flatMap((chunk) => [new Uint8Array(), chunk]),
      new Uint8Array(),
    ];

    return { chunks, maxBytes: totalByteLength(chunks) + headroom };
  });

function bodySource(chunks: readonly Uint8Array[]): {
  readonly body: ReadableStream<Uint8Array>;
  readonly cancelled: () => boolean;
  readonly deliveredChunkCount: () => number;
} {
  let cancelled = false;
  let deliveredChunkCount = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      cancel() {
        cancelled = true;
      },
      pull(controller) {
        const chunk = chunks[deliveredChunkCount];

        if (chunk === undefined) {
          controller.close();
          return;
        }

        deliveredChunkCount += 1;
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );

  return {
    body,
    cancelled: () => cancelled,
    deliveredChunkCount: () => deliveredChunkCount,
  };
}

function totalByteLength(chunks: readonly Uint8Array[]): number {
  return chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
}

describe("bounded HTTP body properties", () => {
  test.prop([bodyReadScenarioArbitrary], {
    numRuns: 1_000,
  })(
    "reassembles non-empty subarray views across empty chunks without offset drift",
    async (scenario) => {
      const source = bodySource(scenario.chunks);
      const result = await readBodyUpTo(source.body, scenario.maxBytes);
      const expectedBytes = Uint8Array.from(scenario.chunks.flatMap((chunk) => [...chunk]));

      expect(result).toEqual({ bytes: expectedBytes, ok: true });
      expect(source.deliveredChunkCount()).toBe(scenario.chunks.length);
      expect(source.cancelled()).toBe(false);
    },
  );
});
