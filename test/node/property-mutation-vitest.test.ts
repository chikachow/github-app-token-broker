import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readMutationTestResult } from "../../scripts/property-mutation-vitest.ts";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const passingTest =
  'import { test, expect } from "vitest"; test("observed property", () => expect(1).toBe(1));';
const failingTest =
  'import { test, expect } from "vitest"; test("observed property", () => expect(1).toBe(2));';

describe("property mutation Vitest evidence", () => {
  it.each([
    { name: "passing tests", source: passingTest, passed: true },
    { name: "an executed assertion failure", source: failingTest, passed: false },
  ])(
    "classifies $name from the completed run",
    ({ source, passed }) => {
      withVitestRun({ source }, (result, reportPath) => {
        expect(readMutationTestResult(result, reportPath)).toMatchObject({
          exitCode: passed ? 0 : 1,
          failedTests: passed ? [] : ["fixture.test.mjs: observed property"],
          passed,
        });
      });
    },
    20_000,
  );

  it.each([
    {
      name: "configuration initialization failure",
      source: passingTest,
      config: 'throw new Error("fixture initialization failure");',
      expectedOutput: "fixture initialization failure",
    },
    {
      name: "collection failure",
      source: 'throw new Error("fixture collection failure");',
      expectedOutput: "fixture collection failure",
    },
    {
      name: "no matching files",
      source: passingTest,
      arguments: ["missing.test.mjs"],
      expectedOutput: "No test files found",
    },
    {
      name: "no matching test names",
      source: passingTest,
      arguments: ["--testNamePattern=missing test"],
      expectedOutput: "skipped",
      expectedExit: 0,
    },
    {
      name: "an unhandled error with passing tests",
      source: unhandledErrorTest(false),
      expectedOutput: "fixture unhandled rejection",
    },
    {
      name: "an unhandled error with a failed assertion",
      source: unhandledErrorTest(true),
      expectedOutput: "fixture unhandled rejection",
    },
    ...[passingTest, failingTest].map((source) => ({
      name: `global teardown failure with ${source === passingTest ? "passing tests" : "a failed assertion"}`,
      source,
      config: 'export default { test: { include: ["*.test.mjs"], globalSetup: ["./setup.mjs"] } };',
      setup: 'export default () => () => { throw new Error("fixture global teardown failure"); };',
      expectedOutput: "fixture global teardown failure",
      expectedExit: source === passingTest ? 0 : 1,
    })),
    ...[passingTest, failingTest].map((source) => ({
      name: `process shutdown timeout with ${source === passingTest ? "passing tests" : "a failed assertion"}`,
      source,
      config:
        'export default { test: { include: ["*.test.mjs"], globalSetup: ["./setup.mjs"], teardownTimeout: 100 } };',
      setup: "export default () => { setInterval(() => {}, 10_000); };",
      expectedOutput: "close timed out",
      expectedExit: source === passingTest ? 0 : 1,
    })),
    ...[passingTest, failingTest].map((source) => ({
      name: `an unhandled global teardown rejection with ${source === passingTest ? "passing tests" : "a failed assertion"}`,
      source,
      config: 'export default { test: { include: ["*.test.mjs"], globalSetup: ["./setup.mjs"] } };',
      setup: `export default () => async () => {
        void Promise.reject(new Error("fixture teardown unhandled rejection"));
        await new Promise(resolve => setTimeout(resolve, 20));
      };`,
      expectedOutput: "fixture teardown unhandled rejection",
    })),
  ])(
    "rejects $name as mutation evidence",
    (fixture) => {
      withVitestRun(fixture, (result, reportPath) => {
        expect(result.error).toBeUndefined();
        expect(result.status).toBe("expectedExit" in fixture ? fixture.expectedExit : 1);
        expect(`${result.stdout}\n${result.stderr}`).toContain(fixture.expectedOutput);
        expect(() => readMutationTestResult(result, reportPath)).toThrow("invalid-vitest-run");
      });
    },
    20_000,
  );
});

function unhandledErrorTest(fail: boolean): string {
  return `import { test, expect } from "vitest";
test("observed property", async () => {
  void Promise.reject(new Error("fixture unhandled rejection"));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(1).toBe(${fail ? 2 : 1});
});`;
}

function withVitestRun(
  fixture: { source: string; config?: string; arguments?: string[]; setup?: string },
  inspect: (result: ReturnType<typeof runVitest>, reportPath: string) => void,
): void {
  const directory = mkdtempSync(join(tmpdir(), "broker-mutation-vitest-"));

  try {
    symlinkSync(join(repository, "node_modules"), join(directory, "node_modules"), "dir");
    writeFileSync(join(directory, "fixture.test.mjs"), fixture.source);
    if (fixture.setup !== undefined) writeFileSync(join(directory, "setup.mjs"), fixture.setup);
    writeFileSync(
      join(directory, "vitest.config.mjs"),
      fixture.config ?? 'export default { test: { include: ["*.test.mjs"] } };',
    );
    const reportPath = join(directory, "report.json");
    inspect(runVitest(directory, reportPath, fixture.arguments ?? []), reportPath);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function runVitest(directory: string, reportPath: string, arguments_: string[]) {
  return spawnSync(
    process.execPath,
    [
      join(repository, "node_modules/vitest/vitest.mjs"),
      "run",
      "--root",
      directory,
      "--config",
      join(directory, "vitest.config.mjs"),
      "--reporter",
      "dot",
      "--reporter",
      join(repository, "scripts/property-mutation-vitest.ts"),
      "--outputFile",
      reportPath,
      ...arguments_,
    ],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 15_000,
    },
  );
}
