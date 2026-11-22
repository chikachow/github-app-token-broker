/** @public */
export interface TokenExchangeObservation {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly level: "error" | "info" | "warn";
  readonly message?: string;
}

export type ObserveTokenExchange = (observation: TokenExchangeObservation) => Promise<void>;

export type ObserveOidcDiagnostic = (observation: TokenExchangeObservation) => undefined;

export interface TokenExchangeRequestContext {
  /** Earlier cutoff from the host admission clock, in performance.now() milliseconds. */
  readonly hostDeadline?: number;
  readonly observe: ObserveTokenExchange;
  readonly observeOidcDiagnostic?: ObserveOidcDiagnostic | undefined;
  /** Keeps bounded issuer-owned refresh work alive when this request stops waiting. */
  readonly waitUntil?: ((operation: Promise<void>) => void) | undefined;
}
