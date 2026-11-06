import { appendFileSync, readFileSync } from "node:fs";

export function selectDeploymentSource(eventName: string, event: unknown): string {
  if (typeof event !== "object" || event === null) {
    throw new TypeError("A GitHub workflow event is required.");
  }
  let sourceSha: unknown;
  if (eventName === "workflow_run") {
    const run: unknown = "workflow_run" in event ? event.workflow_run : undefined;
    if (
      typeof run !== "object" ||
      run === null ||
      !("event" in run && run.event === "push") ||
      !("head_branch" in run && run.head_branch === "main") ||
      !("status" in run && run.status === "completed") ||
      !("conclusion" in run && run.conclusion === "success")
    ) {
      throw new TypeError("Deployment updates require successful source CI for a main push.");
    }
    sourceSha = "head_sha" in run ? run.head_sha : undefined;
  } else if (eventName === "workflow_dispatch") {
    const inputs: unknown = "inputs" in event ? event.inputs : undefined;
    sourceSha =
      typeof inputs === "object" && inputs !== null && "source_sha" in inputs
        ? inputs.source_sha
        : undefined;
  } else {
    throw new TypeError("Unsupported deployment update event.");
  }
  if (typeof sourceSha !== "string" || !/^[0-9a-f]{40}$/u.test(sourceSha)) {
    throw new TypeError("Select an explicit full source commit SHA whose main-push CI passed.");
  }
  return sourceSha;
}

if (import.meta.main) {
  const eventName = process.env["GITHUB_EVENT_NAME"];
  const eventPath = process.env["GITHUB_EVENT_PATH"];
  const outputPath = process.env["GITHUB_OUTPUT"];
  if (eventName === undefined || eventPath === undefined || outputPath === undefined) {
    throw new Error("GitHub event and output paths are required.");
  }
  const event: unknown = JSON.parse(readFileSync(eventPath, "utf8"));
  const sourceSha = selectDeploymentSource(eventName, event);
  appendFileSync(outputPath, `source_sha=${sourceSha}\n`);
}
