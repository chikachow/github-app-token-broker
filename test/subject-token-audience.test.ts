import { describe, expect, it } from "vitest";

import { parseSubjectTokenAudience } from "../workers/github-app-token-broker/src/subject-token-audience.ts";

describe("subject-token audience configuration", () => {
  it.each([
    "https://broker.example",
    "https://github.example/apps/foo",
    "github-app-token-broker",
    "urn:example:token-broker",
    " audience with spaces ",
  ])("preserves the exact scalar audience %j", (audience) => {
    expect(parseSubjectTokenAudience(audience)).toBe(audience);
  });

  it.each([
    ["missing", undefined, "is required"],
    ["empty", "", "is required"],
    ["whitespace", "   ", "is required"],
    ["non-string", 42, "is required"],
    ["plural", ["https://broker.example"], "is required"],
    ["carriage return", "first\rsecond", "exact single-line string"],
    ["line feed", "first\nsecond", "exact single-line string"],
    ["line separator", "first\u2028second", "exact single-line string"],
    ["paragraph separator", "first\u2029second", "exact single-line string"],
  ] as const)("rejects a %s value", (_caseName, value, message) => {
    expect(() => parseSubjectTokenAudience(value)).toThrow(message);
  });
});
