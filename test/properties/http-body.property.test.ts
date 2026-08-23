import { test } from "@fast-check/vitest";
import { describe } from "vitest";

import {
  bodyGeneratedRunBudget,
  bodyReadScenarioArbitrary,
  expectBodyReadScenario,
} from "./support/http-body.ts";

describe("bounded HTTP body properties", () => {
  test.prop([bodyReadScenarioArbitrary], {
    numRuns: bodyGeneratedRunBudget,
  })(
    "reassembles non-empty subarray views across empty chunks without offset drift",
    expectBodyReadScenario,
  );
});
