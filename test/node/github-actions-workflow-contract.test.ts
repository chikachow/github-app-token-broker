import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowDirectory = new URL("../../.github/workflows/", import.meta.url);
const wranglerConfigs = [
  new URL("../../wrangler.jsonc", import.meta.url),
  new URL("../../workers/github-app-token-broker/wrangler.jsonc", import.meta.url),
] as const;
const templateTokenBrokerAudience = "https://broker.example";
const tokenBrokerWorkflows = [
  "pnpm-up.yml",
  "run-github-app-token-broker-deploy-update.yml",
] as const;
const actionRelease =
  "chikachow/cyspbot-app-token-action@bf8d299cd20f755c47feb733e3c0f56331a4b49e # v0.0.12";
const actionReference =
  "chikachow/cyspbot-app-token-action@bf8d299cd20f755c47feb733e3c0f56331a4b49e";
const actionRepository = "chikachow/cyspbot-app-token-action@";
const tokenOutputReference = "${{ steps.broker.outputs.token }}";
const tokenOutputReferencePattern = /\$\{\{\s*steps\.broker\.outputs\.token\s*\}\}/gu;
const createPullRequestActionReference =
  "peter-evans/create-pull-request@5f6978faf089d4d20b00c7766989d076bb2fc7f1";

describe("GitHub Actions workflow configuration contract", () => {
  it("pins the compatible cyspbot action with an explicit resource and scope", async () => {
    const workflowFileNames = (await readdir(workflowDirectory)).filter((fileName) =>
      /\.ya?ml$/u.test(fileName),
    );
    const workflows = await Promise.all(
      workflowFileNames.map(async (fileName) => ({
        contents: await readFile(new URL(fileName, workflowDirectory), "utf8"),
        fileName,
      })),
    );

    expect(
      workflows.flatMap(({ contents, fileName }) =>
        /\bvars(?:\.|\[\s*["'])GITHUB_/u.test(contents) ? [fileName] : [],
      ),
    ).toEqual([]);

    const expectedRequests = {
      "pnpm-up.yml": {
        consumer: {
          field: "with",
          key: "token",
          value: tokenOutputReference,
          uses: createPullRequestActionReference,
        },
        resource: "https://api.github.com/repos/chikachow/github-app-token-broker",
        scope: "contents:write pull_requests:write",
      },
      "run-github-app-token-broker-deploy-update.yml": {
        consumer: {
          field: "env",
          key: "GH_TOKEN",
          run: "gh workflow run update-github-app-token-broker.yml --repo chikachow/github-app-token-broker-deploy --ref main",
          value: tokenOutputReference,
        },
        resource: "https://api.github.com/repos/chikachow/github-app-token-broker-deploy",
        scope: "actions:write",
      },
    } as const;

    for (const fileName of tokenBrokerWorkflows) {
      const workflow = workflows.find((candidate) => candidate.fileName === fileName);
      const contents = workflow?.contents ?? "";
      const document = parse(contents) as {
        jobs?: Record<string, { steps?: readonly Record<string, unknown>[] }>;
      };
      const jobs = Object.values(document.jobs ?? {});
      const brokerActionSteps = jobs.flatMap((job) =>
        (job.steps ?? []).filter(
          (step) => typeof step["uses"] === "string" && step["uses"].startsWith(actionRepository),
        ),
      );
      const actionStep = brokerActionSteps[0];
      const withInputs = actionStep?.["with"] as Record<string, unknown> | undefined;

      expect(brokerActionSteps).toHaveLength(1);
      expect(actionStep?.["uses"]).toBe(actionReference);
      expect(actionStep?.["id"]).toBe("broker");
      expect(Object.keys(withInputs ?? {}).sort()).toEqual([
        "cyspbot-token-url",
        "resource",
        "scope",
      ]);

      expect(withInputs).toEqual({
        "cyspbot-token-url": "${{ vars.TOKEN_BROKER_URL }}",
        resource: expectedRequests[fileName].resource,
        scope: expectedRequests[fileName].scope,
      });
      expect(contents).toContain(`${actionRelease}`);
      expect(
        findBrokerAndConsumerStepIndexes(jobs, expectedRequests[fileName].consumer),
      ).toHaveLength(1);
      expect(
        allScalarValues(document).flatMap((value) =>
          typeof value === "string" ? (value.match(tokenOutputReferencePattern) ?? []) : [],
        ),
      ).toEqual([tokenOutputReference]);
      expect(contents).not.toContain("github-actions-token-exchange.ts");
      expect(contents).not.toContain("TOKEN_BROKER_AUDIENCE");
    }
  });

  it("uses the public template Subject-Token Audience as the Worker binding", async () => {
    const configs = await Promise.all(wranglerConfigs.map((file) => readFile(file, "utf8")));

    for (const config of configs) {
      expect(config).toContain(`"TOKEN_BROKER_AUDIENCE": "${templateTokenBrokerAudience}"`);
      expect(config).not.toContain('"TOKEN_BROKER_URL"');
      expect(config).not.toContain('"TOKEN_BROKER_AUDIENCE": "github-app-token-broker"');
      expect(config).not.toContain(
        `"TOKEN_BROKER_AUDIENCE": "${templateTokenBrokerAudience}/token"`,
      );
    }
  });
});

function findBrokerAndConsumerStepIndexes(
  jobs: readonly { steps?: readonly Record<string, unknown>[] }[],
  consumer: {
    readonly field: "env" | "with";
    readonly key: string;
    readonly run?: string;
    readonly uses?: string;
    readonly value: string;
  },
): readonly { readonly broker: number; readonly consumer: number }[] {
  return jobs.flatMap((job) => {
    const steps = job.steps ?? [];
    const broker = steps.findIndex(
      (step) =>
        typeof step["uses"] === "string" &&
        step["uses"].startsWith(actionRepository) &&
        step["id"] === "broker",
    );
    const consumerIndex = steps.findIndex((step) => {
      const values = step[consumer.field] as Record<string, unknown> | undefined;

      return (
        (consumer.run === undefined || step["run"] === consumer.run) &&
        (consumer.uses === undefined || step["uses"] === consumer.uses) &&
        values?.[consumer.key] === consumer.value
      );
    });

    return broker >= 0 && consumerIndex > broker ? [{ broker, consumer: consumerIndex }] : [];
  });
}

function allScalarValues(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap((element) => allScalarValues(element));
  }

  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap((element) => allScalarValues(element));
  }

  return [value];
}
