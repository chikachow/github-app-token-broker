import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { selectDeploymentSource } from "../../scripts/deployment-source.ts";

const testedSha = "a".repeat(40);
const currentSha = "b".repeat(40);
const successfulRun = {
  conclusion: "success",
  event: "push",
  head_branch: "main",
  head_sha: testedSha,
  status: "completed",
};

describe("deployment source selection", () => {
  it("selects the completed CI revision instead of another event or current revision", () => {
    expect(
      selectDeploymentSource("workflow_run", {
        inputs: { source_sha: currentSha },
        workflow_run: successfulRun,
      }),
    ).toBe(testedSha);
  });

  it("uses only the explicitly selected commit for manual updates", () => {
    expect(
      selectDeploymentSource("workflow_dispatch", {
        inputs: { source_sha: testedSha },
        workflow_run: { ...successfulRun, head_sha: currentSha },
      }),
    ).toBe(testedSha);
  });

  it.each([undefined, "", "main", "a".repeat(7), `${testedSha}\n`, 123])(
    "rejects a missing or non-canonical manual source SHA: %j",
    (source_sha) => {
      expect(() => selectDeploymentSource("workflow_dispatch", { inputs: { source_sha } })).toThrow(
        /explicit full source commit SHA/u,
      );
    },
  );

  it.each([
    { conclusion: "failure" },
    { event: "pull_request" },
    { head_branch: "feature" },
    { status: "in_progress" },
    { head_sha: currentSha.slice(0, 7) },
  ])("rejects an ineligible completed-run event: %j", (change) => {
    expect(() =>
      selectDeploymentSource("workflow_run", { workflow_run: { ...successfulRun, ...change } }),
    ).toThrow();
  });

  it("writes the exact selected SHA through the workflow CLI without using GITHUB_SHA", () => {
    const root = mkdtempSync(join(tmpdir(), "deployment-source-test-"));
    try {
      const eventPath = join(root, "event.json");
      const outputPath = join(root, "output");
      writeFileSync(eventPath, JSON.stringify({ workflow_run: successfulRun }));
      writeFileSync(outputPath, "existing=preserved\n");
      const run = () =>
        spawnSync(
          process.execPath,
          [fileURLToPath(new URL("../../scripts/deployment-source.ts", import.meta.url))],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              GITHUB_EVENT_NAME: "workflow_run",
              GITHUB_EVENT_PATH: eventPath,
              GITHUB_OUTPUT: outputPath,
              GITHUB_SHA: currentSha,
            },
          },
        );
      const accepted = run();
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(readFileSync(outputPath, "utf8")).toBe(
        `existing=preserved\nsource_sha=${testedSha}\n`,
      );
      writeFileSync(
        eventPath,
        JSON.stringify({ workflow_run: { ...successfulRun, head_sha: "" } }),
      );
      expect(run().status).not.toBe(0);
      expect(readFileSync(outputPath, "utf8")).toBe(
        `existing=preserved\nsource_sha=${testedSha}\n`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
