import { describe, expect, it } from "vitest";

import { parseGitHubRepositoryFullName } from "../workers/github-app-token-broker/src/policy/configured-token-issuance-policy.ts";

describe("GitHub repository full_name configuration", () => {
  it("returns the owner and repository parts", () => {
    expect(parseGitHubRepositoryFullName("octocat/Hello-World")).toEqual([
      "octocat",
      "Hello-World",
    ]);
  });

  it.each([
    "octocat",
    "octocat/Hello-World/extra",
    "/Hello-World",
    "octocat/",
    "./Hello-World",
    "octocat/.",
    "../Hello-World",
    "octocat/..",
    "octo cat/Hello-World",
    "octocat/Hello World",
    "octocat/Hello%2FWorld",
    "octocat/Hello:World",
  ])("rejects %j", (value) => {
    expect(parseGitHubRepositoryFullName(value)).toBeNull();
  });
});
