import type { SpawnSyncReturns } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

import type { Reporter, TestModule, TestRunEndReason, Vitest } from "vitest/node";

/** @public Loaded by Vitest through the mutation runner's --reporter path. */
export default class PropertyMutationReporter implements Reporter {
  private outputFile: string | undefined;
  private invalidated = false;
  private report: string | undefined;

  onInit(vitest: Vitest): void {
    if (typeof vitest.config.outputFile !== "string") {
      throw new Error("property mutation reporter requires one output file");
    }

    this.outputFile = vitest.config.outputFile;

    // Vitest's close() swallows shutdown failures and logs them after onClose.
    // Those errors must invalidate the earlier onTestRunEnd evidence.
    let closing = false;
    vitest.onClose(() => {
      closing = true;
      if (vitest.state.getUnhandledErrors().length > 0) this.invalidateReport();
      // An abrupt exit during global teardown must leave no completed-run evidence.
      if (!this.invalidated && this.outputFile !== undefined && this.report !== undefined) {
        writeFileSync(this.outputFile, this.report);
      }
    });
    const logError = vitest.logger.error.bind(vitest.logger);
    vitest.logger.error = (...messages: unknown[]) => {
      if (closing) this.invalidateReport();
      logError(...messages);
    };
  }

  onTestRunEnd(
    testModules: readonly TestModule[],
    unhandledErrors: readonly unknown[],
    reason: TestRunEndReason,
  ): void {
    if (this.outputFile === undefined || this.invalidated) {
      throw new Error("property mutation reporter is not ready to report");
    }

    const report = {
      reason,
      unhandledErrors: unhandledErrors.length,
      suiteErrors: 0,
      pendingTests: 0,
      passedTests: 0,
      failedTests: [] as string[],
    };

    for (const module of testModules) {
      report.suiteErrors += module.errors().length;
      for (const suite of module.children.allSuites()) {
        report.suiteErrors += suite.errors().length;
      }
      for (const test of module.children.allTests()) {
        const state = test.result().state;
        if (state === "failed") {
          report.failedTests.push(`${module.relativeModuleId}: ${test.fullName}`);
        } else if (state === "passed") {
          report.passedTests += 1;
        } else if (state === "pending") {
          report.pendingTests += 1;
        }
      }
    }

    this.report = JSON.stringify(report);
  }

  onProcessTimeout(): void {
    this.invalidateReport();
  }

  private invalidateReport(): void {
    this.invalidated = true;
    if (this.outputFile !== undefined) rmSync(this.outputFile, { force: true });
  }
}

export function readMutationTestResult(result: SpawnSyncReturns<string>, reportPath: string) {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");

  try {
    if (result.error !== undefined || (result.status !== 0 && result.status !== 1)) {
      throw new Error("test process did not exit normally", { cause: result.error });
    }

    const report: unknown = JSON.parse(readFileSync(reportPath, "utf8"));
    if (
      typeof report !== "object" ||
      report === null ||
      !("reason" in report) ||
      (report.reason !== "passed" && report.reason !== "failed") ||
      !("unhandledErrors" in report) ||
      report.unhandledErrors !== 0 ||
      !("suiteErrors" in report) ||
      report.suiteErrors !== 0 ||
      !("pendingTests" in report) ||
      report.pendingTests !== 0 ||
      !("passedTests" in report) ||
      typeof report.passedTests !== "number" ||
      !Number.isSafeInteger(report.passedTests) ||
      report.passedTests < 0 ||
      !("failedTests" in report) ||
      !Array.isArray(report.failedTests) ||
      !report.failedTests.every(
        (test: unknown): test is string => typeof test === "string" && test.length > 0,
      ) ||
      report.passedTests + report.failedTests.length === 0 ||
      (result.status === 0) !== (report.failedTests.length === 0) ||
      (result.status === 0) !== (report.reason === "passed")
    ) {
      throw new Error("report does not establish a completed test run without runner errors");
    }

    return {
      exitCode: result.status,
      failedTests: report.failedTests,
      output,
      passed: result.status === 0,
    };
  } catch (error) {
    throw new Error(`invalid-vitest-run: cannot classify mutation sensitivity\n${output}`, {
      cause: error,
    });
  }
}
