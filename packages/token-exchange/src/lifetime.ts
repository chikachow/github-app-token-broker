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
export function createTokenExchangeLifetime(parentSignal?: AbortSignal): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const cancel = () => controller.abort(new TokenExchangeUnavailableError());
  const timer = setTimeout(cancel, successDeadlineMilliseconds);
  parentSignal?.addEventListener("abort", cancel, { once: true });
  if (parentSignal?.aborted === true) cancel();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", cancel);
    },
  };
}

export function assertTokenExchangeActive(signal: AbortSignal): void {
  if (signal.aborted) throw new TokenExchangeUnavailableError();
}

/** Stops waiting without cancelling issuer-owned refreshes shared by other requests. */
export async function awaitTokenExchangeOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  try {
    const result = await awaitWithAbortSignal(operation, signal);
    assertTokenExchangeActive(signal);
    return result;
  } catch (error) {
    assertTokenExchangeActive(signal);
    throw error;
  }
}

export function observeWithinTokenExchangeLifetime(
  observe: ObserveTokenExchange,
  signal: AbortSignal,
): ObserveTokenExchange {
  return async (observation) => {
    assertTokenExchangeActive(signal);
    try {
      await awaitWithAbortSignal(observe(observation), signal);
      assertTokenExchangeActive(signal);
    } catch {
      // A started mandatory acknowledgement owns failure precedence, including timeout.
      throw new MandatoryObservationError();
    }
  };
}
