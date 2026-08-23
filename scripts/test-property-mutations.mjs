import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { propertyMutations } from "./property-mutations.mjs";

const help = `Usage: pnpm test:mutations:property [--format=json]

Runs the curated property-test mutation matrix against the committed HEAD in an
automatically removed local clone. The source worktree must be clean. This is a
targeted sensitivity check, not an exhaustive mutation score.`;

if (process.argv.includes("--help")) {
  process.stdout.write(`${help}\n`);
  process.exit(0);
}

const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--format=json");

if (unknownArguments.length > 0) {
  throw new Error(`unknown argument(s): ${unknownArguments.join(", ")}`);
}

const jsonOutput = process.argv.includes("--format=json");
const repository = resolve(import.meta.dirname, "..");
const status = git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]);

if (status.length > 0) {
  throw new Error(
    "property mutation testing requires a clean committed revision; commit or remove every tracked and untracked change first",
  );
}

const head = git(repository, ["rev-parse", "--verify", "HEAD"]);
const temporaryRoot = mkdtempSync(join(tmpdir(), "github-app-token-broker-property-mutations-"));
const clone = join(temporaryRoot, "repository");

try {
  runChecked("git", ["clone", "--quiet", "--local", "--no-hardlinks", repository, clone]);
  runChecked("git", ["checkout", "--quiet", "--detach", head], clone);
  runPackageManager(["install", "--frozen-lockfile", "--ignore-scripts"], clone);
  runPackageManager(["run", "typecheck"], clone);

  const controls = runControlLanes(clone);
  const results = [];

  for (const [index, mutation] of propertyMutations.entries()) {
    progress(`[${index + 1}/${propertyMutations.length}] ${mutation.id}`);
    const sourcePath = join(clone, mutation.file);
    const original = readFileSync(sourcePath, "utf8");

    try {
      const mutated = mutation.replacements.reduce(
        (source, replacement) =>
          replaceExactlyOnce(source, replacement.search, replacement.replacement),
        original,
      );

      writeFileSync(sourcePath, mutated);
      try {
        runPackageManager(["run", "typecheck"], clone);
      } catch (error) {
        throw new Error(`invalid-mutant ${mutation.id}: repository typecheck failed`, {
          cause: error,
        });
      }

      const ordinary = runVitest(clone, mutation.tests.ordinary);
      const property = runVitest(clone, mutation.tests.property);
      const classification = classifyMutation({ ordinary, property });

      results.push({
        classification,
        description: mutation.description,
        id: mutation.id,
        lanes: {
          ordinary: { exitCode: ordinary.exitCode, killed: !ordinary.passed },
          property: { exitCode: property.exitCode, killed: !property.passed },
        },
        mutantTypechecked: true,
      });
    } finally {
      writeFileSync(sourcePath, original);
    }
  }

  const report = {
    controls,
    head,
    matrixKind: "curated-property-sensitivity",
    results,
  };

  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printReadableReport(report);
  }

  const failed = results.filter((result) => !result.lanes.property.killed);

  if (failed.length > 0) {
    process.exitCode = 1;
  }
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}

function git(cwd, arguments_) {
  return execFileSync("git", arguments_, { cwd, encoding: "utf8" }).trim();
}

function packageManagerInvocation(arguments_) {
  const executable = process.env.npm_execpath;

  return executable === undefined
    ? { arguments: arguments_, command: "pnpm" }
    : { arguments: [executable, ...arguments_], command: process.execPath };
}

function printReadableReport(report) {
  process.stdout.write(`Property mutation sensitivity for ${report.head}\n\n`);

  for (const result of report.results) {
    const checks = [
      `typecheck=${result.mutantTypechecked ? "passed" : "failed"}`,
      `ordinary=${laneSummary(result.lanes.ordinary)}`,
      `property=${laneSummary(result.lanes.property)}`,
    ].join(" ");

    process.stdout.write(`${result.classification.padEnd(15)} ${result.id} ${checks}\n`);
  }

  const counts = Object.groupBy(report.results, ({ classification }) => classification);
  process.stdout.write(
    `\nSummary: ${report.results.length} curated mutants; ` +
      `${counts["defence-in-depth"]?.length ?? 0} defence-in-depth, ` +
      `${counts["property-unique"]?.length ?? 0} property-unique, ` +
      `${counts.unsupported?.length ?? 0} unsupported, ` +
      `${counts.surviving?.length ?? 0} surviving.\n`,
  );
}

function progress(message) {
  process.stderr.write(`${message}\n`);
}

function laneSummary(lane) {
  return `${lane.killed ? "killed" : "survived"}(exit=${lane.exitCode})`;
}

function classifyMutation({ ordinary, property }) {
  if (!property.passed) {
    return ordinary.passed ? "property-unique" : "defence-in-depth";
  }

  return ordinary.passed ? "surviving" : "unsupported";
}

function runControlLanes(cwd) {
  const configurations = new Map();
  const laneResults = new Map();

  for (const mutation of propertyMutations) {
    configurations.set(mutation.tests.suite, mutation.tests);
  }

  progress("[control] full");
  const full = runVitest(cwd, { files: [], projects: [] });

  if (!full.passed) {
    throw new Error(`unmutated-control-failed full: exit code ${full.exitCode}\n${full.output}`);
  }

  const suites = {};

  for (const [suite, tests] of configurations) {
    progress(`[control] ${suite}`);
    const lanes = {
      ordinary: runVitestOnce(cwd, tests.ordinary, laneResults),
      property: runVitestOnce(cwd, tests.property, laneResults),
    };

    for (const [lane, result] of Object.entries(lanes)) {
      if (!result.passed) {
        throw new Error(
          `unmutated-control-failed ${suite}/${lane}: exit code ${result.exitCode}\n${result.output}`,
        );
      }
    }

    suites[suite] = Object.fromEntries(
      Object.entries(lanes).map(([lane, result]) => [lane, { exitCode: result.exitCode }]),
    );
  }

  return { full: { exitCode: full.exitCode }, suites };
}

function runVitestOnce(cwd, lane, results) {
  const key = JSON.stringify(lane);
  let result = results.get(key);

  if (result === undefined) {
    result = runVitest(cwd, lane);
    results.set(key, result);
  }

  return result;
}

function replaceExactlyOnce(source, search, replacement) {
  const first = source.indexOf(search);

  if (first === -1 || source.indexOf(search, first + search.length) !== -1) {
    throw new Error(
      `mutation source must match exactly once; observed ${occurrences(source, search)}`,
    );
  }

  return `${source.slice(0, first)}${replacement}${source.slice(first + search.length)}`;
}

function occurrences(source, search) {
  let count = 0;
  let offset = 0;

  while (true) {
    const match = source.indexOf(search, offset);

    if (match === -1) {
      return count;
    }

    count += 1;
    offset = match + search.length;
  }
}

function runChecked(command, arguments_, cwd = repository) {
  const result = runCommand(command, arguments_, cwd);

  if (result.status !== 0) {
    throw new Error(commandFailure(command, arguments_, result));
  }
}

function runCommand(command, arguments_, cwd) {
  return spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    env: testEnvironment(),
  });
}

function runPackageManager(arguments_, cwd) {
  const invocation = packageManagerInvocation(arguments_);
  runChecked(invocation.command, invocation.arguments, cwd);
}

function runVitest(cwd, lane) {
  const projectArguments = lane.projects.flatMap((project) => ["--project", project]);
  const testNameArguments =
    lane.testNamePattern === undefined ? [] : ["--testNamePattern", lane.testNamePattern];
  const arguments_ = [
    "exec",
    "vitest",
    "run",
    ...lane.files,
    ...projectArguments,
    ...testNameArguments,
    "--reporter=dot",
  ];
  const invocation = packageManagerInvocation(arguments_);
  const result = runCommand(invocation.command, invocation.arguments, cwd);

  if (result.error !== undefined || result.status === null) {
    throw new Error(commandFailure(invocation.command, invocation.arguments, result));
  }

  return {
    exitCode: result.status,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
    passed: result.status === 0,
  };
}

function testEnvironment() {
  return {
    ...process.env,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    WRANGLER_LOG: "none",
    WRANGLER_LOG_PATH: ".wrangler/logs",
    WRANGLER_REGISTRY_PATH: ".wrangler/registry",
  };
}

function commandFailure(command, arguments_, result) {
  return [
    `command failed: ${command} ${arguments_.join(" ")}`,
    result.error?.message,
    result.stdout,
    result.stderr,
  ]
    .filter(Boolean)
    .join("\n");
}
