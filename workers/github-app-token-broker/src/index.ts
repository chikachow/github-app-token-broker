export {
  createConfiguredTokenExchangeWorker,
  createTokenExchangeWorker,
  type TokenExchangeWorkerDependencies,
  type TokenExchangeWorkerRuntimeDependencies,
} from "./worker.ts";

import { createConfiguredTokenExchangeWorker } from "./worker.ts";

export default createConfiguredTokenExchangeWorker();
