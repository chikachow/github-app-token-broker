import fc from "fast-check";
import { expect } from "vitest";

import { readBodyUpTo } from "@github-app-token-broker/http/body";

export const bodyGeneratedRunBudget = 1_000;

interface BodyReadScenario {
  readonly chunks: readonly Uint8Array[];
  readonly maxBytes: number;
}

const plainChunkArbitrary = fc.uint8Array({ maxLength: 16 });
const viewChunkArbitrary = fc
  .tuple(plainChunkArbitrary, fc.integer({ max: 4, min: 1 }), fc.integer({ max: 4, min: 1 }))
  .map(([bytes, prefixLength, suffixLength]) => {
    const backing = new Uint8Array(prefixLength + bytes.byteLength + suffixLength);
    backing.set(bytes, prefixLength);

    return backing.subarray(prefixLength, prefixLength + bytes.byteLength);
  });
const chunkArbitrary = fc.oneof(
  { arbitrary: plainChunkArbitrary, weight: 2 },
  { arbitrary: viewChunkArbitrary, weight: 1 },
);
const chunksArbitrary = fc.array(chunkArbitrary, { maxLength: 12 });
const chunksContainingBytesArbitrary = fc
  .tuple(
    fc.array(chunkArbitrary, { maxLength: 5 }),
    fc.uint8Array({ maxLength: 16, minLength: 1 }),
    fc.array(chunkArbitrary, { maxLength: 5 }),
  )
  .map(([before, nonEmpty, after]) => [...before, nonEmpty, ...after]);

const acceptedBodyArbitrary = chunksArbitrary.chain((chunks) => {
  const byteLength = totalByteLength(chunks);

  return fc
    .integer({ max: byteLength + 32, min: byteLength })
    .map((maxBytes) => ({ chunks, maxBytes }));
});
const exactLimitBodyArbitrary = chunksArbitrary.map((chunks) => ({
  chunks,
  maxBytes: totalByteLength(chunks),
}));
const oversizedBodyArbitrary = chunksContainingBytesArbitrary.chain((chunks) =>
  fc
    .integer({ max: totalByteLength(chunks) - 1, min: 0 })
    .map((maxBytes) => ({ chunks, maxBytes })),
);

export const bodyReadScenarioArbitrary: fc.Arbitrary<BodyReadScenario> = fc.oneof(
  acceptedBodyArbitrary,
  exactLimitBodyArbitrary,
  oversizedBodyArbitrary,
);

export const bodyReadExamples: [BodyReadScenario][] = [
  [{ chunks: [], maxBytes: 0 }],
  [{ chunks: [new Uint8Array(), new Uint8Array()], maxBytes: 0 }],
  [{ chunks: [Uint8Array.of(9, 1, 2, 9).subarray(1, 3)], maxBytes: 2 }],
  [{ chunks: [Uint8Array.of(1)], maxBytes: 2 }],
  [{ chunks: [Uint8Array.of(1), Uint8Array.of(2, 3)], maxBytes: 3 }],
  [
    {
      chunks: [Uint8Array.of(1, 2), Uint8Array.of(3, 4), Uint8Array.of(5, 6)],
      maxBytes: 3,
    },
  ],
];

export async function expectBodyReadScenario(scenario: BodyReadScenario): Promise<void> {
  const source = bodySource(scenario.chunks);
  const result = await readBodyUpTo(source.body, scenario.maxBytes);
  const expectedBytes = Uint8Array.from(scenario.chunks.flatMap((chunk) => [...chunk]));
  const oversized = expectedBytes.byteLength > scenario.maxBytes;

  expect(result).toEqual(oversized ? { ok: false } : { bytes: expectedBytes, ok: true });
  expect(source.deliveredChunkCount()).toBe(
    oversized ? chunksThroughLimit(scenario.chunks, scenario.maxBytes) : scenario.chunks.length,
  );
  expect(source.cancelled()).toBe(oversized);
}

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

function chunksThroughLimit(chunks: readonly Uint8Array[], maxBytes: number): number {
  let byteLength = 0;

  for (const [index, chunk] of chunks.entries()) {
    byteLength += chunk.byteLength;

    if (byteLength > maxBytes) {
      return index + 1;
    }
  }

  throw new Error("expected chunks to exceed the byte limit");
}

function totalByteLength(chunks: readonly Uint8Array[]): number {
  return chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
}
