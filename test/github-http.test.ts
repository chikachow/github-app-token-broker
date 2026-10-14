import { describe, expect, it } from "vitest";

import { GitHubApiError } from "../packages/github/src/http.ts";

describe("GitHub API error defaults", () => {
  it("defaults to no rate limit and preserves the supplied upstream status", () => {
    const error = new GitHubApiError(503, "GitHub API request failed");

    expect(error.rateLimited).toBe(false);
    expect(error.status).toBe(503);
    expect(error.upstreamStatus).toBe(503);
    expect(error.message).toBe("GitHub API request failed");
  });

  it("preserves explicit rate-limit classification and a distinct upstream status", () => {
    const error = new GitHubApiError(502, "Invalid upstream response", true, 403);

    expect(error.rateLimited).toBe(true);
    expect(error.status).toBe(502);
    expect(error.upstreamStatus).toBe(403);
  });
});
