import { awaitWithAbortSignal } from "@github-app-token-broker/http/abort";
import type { ObserveTokenExchange } from "./events.ts";

const successDeadlineMilliseconds = 45_000;

export class TokenExchangeUnavailableError extends Error {
  constructor() {
    super("Token Exchange operation no longer available");
  }
}

export class MandatoryObservationError extends Error {
  constructor() {
    super("mandatory Token Exchange observation was not acknowledged");
  }
}

/** Starts the broker-owned success budget before host admission or body acquisition. */
export function createTokenExchangeLifetime(parentSignal?: AbortSignal, hostDeadline = Infinity) {
  const startedAt = performance.now();
  const deadline = Math.min(startedAt + successDeadlineMilliseconds, hostDeadline);
  const controller = new AbortController();
  const cancel = () => controller.abort(new TokenExchangeUnavailableError());
  const timer = setTimeout(cancel, deadline - startedAt);
  parentSignal?.addEventListener("abort", cancel, { once: true });
  if (parentSignal?.aborted === true || !(startedAt < deadline)) cancel();
  return {
    deadline,
    signal: controller.signal,
    assertActive() {
      if (!(performance.now() < deadline)) cancel();
      controller.signal.throwIfAborted();
    },
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", cancel);
    },
  };
}

export type TokenExchangeLifetime = ReturnType<typeof createTokenExchangeLifetime>;

/** Stops waiting without cancelling issuer-owned refreshes shared by other requests. */
export async function awaitTokenExchangeOperation<T>(
  operation: Promise<T>,
  lifetime: TokenExchangeLifetime,
): Promise<T> {
  try {
    const result = await awaitWithAbortSignal(operation, lifetime.signal);
    lifetime.assertActive();
    return result;
  } catch (error) {
    lifetime.assertActive();
    throw error;
  }
}

export function observeWithinTokenExchangeLifetime(
  observe: ObserveTokenExchange,
  lifetime: TokenExchangeLifetime,
): ObserveTokenExchange {
  return async (observation) => {
    lifetime.assertActive();
    try {
      await awaitWithAbortSignal(observe(observation), lifetime.signal);
      lifetime.assertActive();
    } catch {
      // A started mandatory acknowledgement owns failure precedence, including timeout.
      throw new MandatoryObservationError();
    }
  };
}
