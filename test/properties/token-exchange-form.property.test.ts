import { test } from "@fast-check/vitest";
import { describe } from "vitest";

import {
  expectFormScenario,
  formGeneratedRunBudget,
  formScenarioArbitrary,
} from "./support/token-exchange-form.ts";

describe("Token Exchange form properties", () => {
  test.prop([formScenarioArbitrary], {
    numRuns: formGeneratedRunBudget,
  })("keeps one non-empty form value regardless of empty-value ordering", expectFormScenario);
});
