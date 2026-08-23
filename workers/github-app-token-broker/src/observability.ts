import type {
  ObserveOidcDiagnostic,
  ObserveTokenExchange,
  TokenExchangeObservation,
} from "@github-app-token-broker/token-exchange";

export type { ObserveOidcDiagnostic, ObserveTokenExchange };

export const observeTokenExchangeWithConsole: ObserveTokenExchange = async (observation) => {
  writeTokenExchangeObservationToConsole(observation);
};

export const observeOidcDiagnosticWithConsole: ObserveOidcDiagnostic = (observation) => {
  writeTokenExchangeObservationToConsole(observation);

  return undefined;
};

function writeTokenExchangeObservationToConsole(observation: TokenExchangeObservation): void {
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
}
