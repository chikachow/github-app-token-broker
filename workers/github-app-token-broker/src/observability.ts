export interface TokenExchangeObservation {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly level: "error" | "info" | "warn";
  readonly message?: string;
}

export type ObserveTokenExchange = (observation: TokenExchangeObservation) => void;

export const observeTokenExchangeWithConsole: ObserveTokenExchange = (observation) => {
  const values = observation.message
    ? ([observation.message, observation.fields] as const)
    : ([observation.fields] as const);

  switch (observation.level) {
    case "error":
      console.error(...values);
      break;
    case "info":
      console.info(...values);
      break;
    case "warn":
      console.warn(...values);
  }
};
