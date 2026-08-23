/** @public */
export interface TokenExchangeObservation {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly level: "error" | "info" | "warn";
  readonly message?: string;
}

export type ObserveTokenExchange = (observation: TokenExchangeObservation) => Promise<void>;

export type ObserveOidcDiagnostic = (observation: TokenExchangeObservation) => undefined;

export interface TokenExchangeRequestContext {
  readonly observe: ObserveTokenExchange;
  readonly observeOidcDiagnostic?: ObserveOidcDiagnostic | undefined;
}
