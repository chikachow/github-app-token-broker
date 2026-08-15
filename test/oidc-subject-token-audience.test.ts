import { describe, expect, it } from "vitest";

import {
  parseSubjectTokenAudience,
  type SubjectTokenAudience,
} from "@github-app-token-broker/oidc/subject-token-audience";

describe("OIDC subject-token audience", () => {
  it.each([
    "https://broker.example",
    "https://github.example/apps/foo",
    "github-app-token-broker",
    "urn:example:token-broker",
    " audience with spaces ",
  ])("preserves the exact scalar audience %j", (audience) => {
    const parsed: SubjectTokenAudience = parseSubjectTokenAudience(audience);

    expect(parsed).toBe(audience);
  });

  it.each([
    ["missing", undefined, "Subject-Token Audience is required"],
    ["empty", "", "Subject-Token Audience is required"],
    ["whitespace", "   ", "Subject-Token Audience is required"],
    ["non-string", 42, "Subject-Token Audience is required"],
    ["plural", ["https://broker.example"], "Subject-Token Audience is required"],
    [
      "carriage return",
      "first\rsecond",
      "Subject-Token Audience must be an exact single-line string",
    ],
    ["line feed", "first\nsecond", "Subject-Token Audience must be an exact single-line string"],
    [
      "line separator",
      "first\u2028second",
      "Subject-Token Audience must be an exact single-line string",
    ],
    [
      "paragraph separator",
      "first\u2029second",
      "Subject-Token Audience must be an exact single-line string",
    ],
  ] as const)("rejects a %s value", (_caseName, value, message) => {
    expect(() => parseSubjectTokenAudience(value)).toThrow(message);
  });
});
